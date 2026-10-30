package objects

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestMemPutGet(t *testing.T) {
	ctx := context.Background()
	m := NewMem("http://dev.test", nil)
	if _, _, err := m.Get(ctx, "t/t1/missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}
	body := []byte("hello")
	if err := m.Put(ctx, "t/t1/a", "text/plain", body); err != nil {
		t.Fatal(err)
	}
	body[0] = 'X' // the store keeps its own copy
	rc, size, err := m.Get(ctx, "t/t1/a")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if string(got) != "hello" || size != 5 {
		t.Fatalf("Get = %q, %d", got, size)
	}
	if ct, ok := m.ContentType("t/t1/a"); !ok || ct != "text/plain" {
		t.Fatalf("ContentType = %q, %v", ct, ok)
	}
}

func TestMemPresignURL(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	m := NewMem("http://dev.test/", Signer("secret"))
	m.now = func() time.Time { return now }
	raw, err := m.PresignPut(context.Background(), "t/t1/imports/i 1.xlsx", ContentTypeXLSX, MaxUploadBytes, UploadTTL)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme+"://"+u.Host != "http://dev.test" || u.Path != "/dev/objects/t/t1/imports/i 1.xlsx" {
		t.Fatalf("url = %s", raw)
	}
	exp := u.Query().Get("exp")
	if exp != strconv.FormatInt(now.Add(UploadTTL).Unix(), 10) {
		t.Fatalf("exp = %s", exp)
	}
	if err := Verify("secret", "t/t1/imports/i 1.xlsx", exp, u.Query().Get("sig"), now); err != nil {
		t.Fatalf("Verify of a fresh URL: %v", err)
	}
}

func TestVerify(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	exp := now.Add(time.Minute)
	sign := Signer("secret")
	good := sign("k", exp)
	e := strconv.FormatInt(exp.Unix(), 10)

	cases := []struct {
		name        string
		secret, key string
		exp, sig    string
		now         time.Time
		want        error
	}{
		{"valid", "secret", "k", e, good, now, nil},
		{"wrong key", "secret", "other", e, good, now, ErrBadSignature},
		{"wrong secret", "other-secret", "k", e, good, now, ErrBadSignature},
		{"empty sig", "secret", "k", e, "", now, ErrBadSignature},
		{"tampered exp", "secret", "k", strconv.FormatInt(exp.Unix()+1, 10), good, now, ErrBadSignature},
		{"non-numeric exp", "secret", "k", "soon", good, now, ErrBadSignature},
		{"expired", "secret", "k", e, good, exp.Add(time.Second), ErrExpired},
		{"expires exactly now", "secret", "k", e, good, exp, ErrExpired},
	}
	for _, c := range cases {
		if got := Verify(c.secret, c.key, c.exp, c.sig, c.now); !errors.Is(got, c.want) {
			t.Errorf("%s: Verify = %v, want %v", c.name, got, c.want)
		}
	}
}

// fakeS3 records requests and answers PutObject and GetObject.
type fakeS3 struct {
	mu   sync.Mutex
	reqs []*http.Request
	body map[string][]byte
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, r.Clone(r.Context()))
	switch r.Method {
	case http.MethodPut:
		b, _ := io.ReadAll(r.Body)
		f.body[r.URL.Path] = b
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		b, ok := f.body[r.URL.Path]
		if !ok {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>nope</Message></Error>`)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		_, _ = w.Write(b)
	}
}

func testS3(t *testing.T) (*S3, *fakeS3) {
	t.Helper()
	f := &fakeS3{body: map[string][]byte{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	cfg := aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("AKIATESTONLY", "test-secret", ""),
	}
	client := NewS3Client(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(srv.URL)
		o.UsePathStyle = true
	})
	return NewS3(client, "uploads-bucket"), f
}

func TestS3PutUsesServerSideEncryptionAndGetRoundTrips(t *testing.T) {
	ctx := context.Background()
	s, f := testS3(t)
	if err := s.Put(ctx, "t/t1/imports/x.changeset.json", "application/json", []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	put := f.reqs[0]
	if got := put.Header.Get("X-Amz-Server-Side-Encryption"); got != "AES256" {
		t.Errorf("SSE header = %q, want AES256", got)
	}
	if put.URL.Path != "/uploads-bucket/t/t1/imports/x.changeset.json" {
		t.Errorf("path = %s", put.URL.Path)
	}
	rc, size, err := s.Get(ctx, "t/t1/imports/x.changeset.json")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if string(got) != `{"a":1}` || size != 7 {
		t.Errorf("Get = %q, %d", got, size)
	}
}

func TestS3GetMissingIsErrNotFound(t *testing.T) {
	s, _ := testS3(t)
	if _, _, err := s.Get(context.Background(), "t/t1/imports/none.xlsx"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}
}

func TestS3PresignPut(t *testing.T) {
	s, _ := testS3(t)
	raw, err := s.PresignPut(context.Background(), "t/t1/imports/x.xlsx", ContentTypeXLSX, MaxUploadBytes, UploadTTL)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Path != "/uploads-bucket/t/t1/imports/x.xlsx" {
		t.Errorf("path = %s", u.Path)
	}
	if q.Get("X-Amz-Expires") != "900" {
		t.Errorf("X-Amz-Expires = %q, want 900", q.Get("X-Amz-Expires"))
	}
	if q.Get("X-Amz-Signature") == "" {
		t.Error("URL is not signed")
	}
	if !strings.Contains(q.Get("X-Amz-SignedHeaders"), "content-type") {
		t.Errorf("content-type is not a signed header: %q", q.Get("X-Amz-SignedHeaders"))
	}
	// A checksum of the empty body in the query string would fail every real
	// upload.
	for k := range q {
		if strings.Contains(strings.ToLower(k), "checksum") {
			t.Errorf("presigned URL carries %s", k)
		}
	}
}
