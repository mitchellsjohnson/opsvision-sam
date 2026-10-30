package objects

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DevObjectsPath is the path prefix of the dev server's upload endpoint.
const DevObjectsPath = "/dev/objects/"

// Mem is an in-memory Store for development and tests. It is safe for
// concurrent use.
type Mem struct {
	baseURL string
	sign    func(key string, exp time.Time) string
	now     func() time.Time

	mu   sync.Mutex
	objs map[string]memObject
}

type memObject struct {
	contentType string
	data        []byte
}

var _ Store = (*Mem)(nil)

// NewMem returns an empty in-memory store. Presigned URLs are
// baseURL + "/dev/objects/<key>?exp=<unix>&sig=<sign(key, exp)>"; the server
// at baseURL must accept them (see Sign and Verify for the scheme the dev
// server uses). A nil sign leaves sig empty.
func NewMem(baseURL string, sign func(key string, exp time.Time) string) *Mem {
	return &Mem{
		baseURL: strings.TrimRight(baseURL, "/"),
		sign:    sign,
		now:     func() time.Time { return time.Now().UTC() },
		objs:    map[string]memObject{},
	}
}

// PresignPut implements Store.
func (m *Mem) PresignPut(_ context.Context, key, _ string, _ int64, ttl time.Duration) (string, error) {
	if key == "" {
		return "", errors.New("objects: empty key")
	}
	exp := m.now().Add(ttl)
	sig := ""
	if m.sign != nil {
		sig = m.sign(key, exp)
	}
	segs := strings.Split(key, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	q := url.Values{"exp": {strconv.FormatInt(exp.Unix(), 10)}, "sig": {sig}}
	return m.baseURL + DevObjectsPath + strings.Join(segs, "/") + "?" + q.Encode(), nil
}

// Get implements Store.
func (m *Mem) Get(_ context.Context, key string) (io.ReadCloser, int64, error) {
	m.mu.Lock()
	o, ok := m.objs[key]
	m.mu.Unlock()
	if !ok {
		return nil, 0, ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(o.data)), int64(len(o.data)), nil
}

// Put implements Store.
func (m *Mem) Put(_ context.Context, key, contentType string, body []byte) error {
	if key == "" {
		return errors.New("objects: empty key")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objs[key] = memObject{contentType: contentType, data: bytes.Clone(body)}
	return nil
}

// ContentType returns the content type an object was stored with.
func (m *Mem) ContentType(key string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objs[key]
	return o.contentType, ok
}

// Keys returns the stored keys, for tests.
func (m *Mem) Keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.objs))
	for k := range m.objs {
		out = append(out, k)
	}
	return out
}

// Signer returns the signing function of dev upload URLs: the hex
// HMAC-SHA256, keyed by secret, of "<key>|<unix expiry>".
func Signer(secret string) func(key string, exp time.Time) string {
	return func(key string, exp time.Time) string { return sigHex(secret, key, exp.Unix()) }
}

func sigHex(secret, key string, exp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(key + "|" + strconv.FormatInt(exp, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// Errors of Verify.
var (
	ErrBadSignature = errors.New("objects: bad signature")
	ErrExpired      = errors.New("objects: upload URL expired")
)

// Verify checks the exp and sig query values of a dev upload URL for key. The
// signature is compared in constant time. It returns ErrBadSignature for a
// malformed or wrong signature and ErrExpired when exp is not after now; the
// signature is checked first, so an unauthenticated caller learns nothing
// about expiry.
func Verify(secret, key, exp, sig string, now time.Time) error {
	unix, err := strconv.ParseInt(exp, 10, 64)
	if err != nil {
		return ErrBadSignature
	}
	want := sigHex(secret, key, unix)
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return ErrBadSignature
	}
	if !now.Before(time.Unix(unix, 0)) {
		return ErrExpired
	}
	return nil
}
