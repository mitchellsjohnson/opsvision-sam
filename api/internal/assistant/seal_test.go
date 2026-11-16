package assistant

import (
	"bytes"
	"context"
	"errors"
	"maps"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/kms"
)

func testKey() []byte { return bytes.Repeat([]byte{7}, 32) }

func TestAESSealerRoundTrip(t *testing.T) {
	s, err := NewAESSealer(testKey())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	ec := CredentialContext("t1", "u1")
	plain := []byte("sk-example-secret-key-0001")
	sealed, err := s.Seal(ctx, plain, ec)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, plain) {
		t.Fatal("sealed bytes contain the plaintext")
	}
	again, err := s.Seal(ctx, plain, ec)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(sealed, again) {
		t.Fatal("two seals of the same plaintext are identical: the nonce is not random")
	}
	got, err := s.Open(ctx, sealed, ec)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("Open = %q, want %q", got, plain)
	}
}

func TestAESSealerBindsEncryptionContext(t *testing.T) {
	s, err := NewAESSealer(testKey())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	sealed, err := s.Seal(ctx, []byte("secret"), CredentialContext("t1", "u1"))
	if err != nil {
		t.Fatal(err)
	}
	for name, ec := range map[string]map[string]string{
		"other user":    CredentialContext("t1", "u2"),
		"other tenant":  CredentialContext("t2", "u1"),
		"other purpose": {"tenant": "t1", "user": "u1", "purpose": "something-else"},
		"empty":         nil,
		"extra key":     {"tenant": "t1", "user": "u1", "purpose": PurposeAssistantCredential, "x": "y"},
	} {
		if _, err := s.Open(ctx, sealed, ec); err == nil {
			t.Errorf("%s: Open succeeded with the wrong encryption context", name)
		}
	}
	// A different key cannot open it either.
	other, err := NewAESSealer(bytes.Repeat([]byte{8}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.Open(ctx, sealed, CredentialContext("t1", "u1")); err == nil {
		t.Error("Open succeeded with another key")
	}
	// Tampering is detected.
	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 1
	if _, err := s.Open(ctx, tampered, CredentialContext("t1", "u1")); err == nil {
		t.Error("Open succeeded on tampered bytes")
	}
	if _, err := s.Open(ctx, sealed[:5], CredentialContext("t1", "u1")); err == nil {
		t.Error("Open succeeded on truncated bytes")
	}
}

func TestAESSealerContextIsCanonical(t *testing.T) {
	s, err := NewAESSealer(testKey())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	// Values that would collide under naive concatenation must not.
	sealed, err := s.Seal(ctx, []byte("secret"), map[string]string{"a": "b=c"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(ctx, sealed, map[string]string{"a=b": "c"}); err == nil {
		t.Error("distinct contexts encode the same")
	}
}

func TestAESSealerRejectsBadKeyLength(t *testing.T) {
	for _, n := range []int{0, 16, 24, 31, 33, 64} {
		if _, err := NewAESSealer(make([]byte, n)); err == nil {
			t.Errorf("NewAESSealer accepted a %d-byte key", n)
		}
	}
}

func TestAESSealerCopiesKey(t *testing.T) {
	key := testKey()
	s, err := NewAESSealer(key)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	sealed, err := s.Seal(ctx, []byte("secret"), nil)
	if err != nil {
		t.Fatal(err)
	}
	clear(key)
	if _, err := s.Open(ctx, sealed, nil); err != nil {
		t.Fatalf("the sealer depends on the caller's key slice: %v", err)
	}
}

// fakeKMS is a KMS that "encrypts" by prefixing, and requires the same key and
// encryption context on decrypt, as the real service does.
type fakeKMS struct {
	encrypts, decrypts []map[string]string
	keyIDs             []string
	err                error
}

func (f *fakeKMS) Encrypt(_ context.Context, in *kms.EncryptInput, _ ...func(*kms.Options)) (*kms.EncryptOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.encrypts = append(f.encrypts, maps.Clone(in.EncryptionContext))
	f.keyIDs = append(f.keyIDs, *in.KeyId)
	blob := append([]byte(*in.KeyId+"|"+canonical(in.EncryptionContext)+"|"), in.Plaintext...)
	return &kms.EncryptOutput{CiphertextBlob: blob}, nil
}

func (f *fakeKMS) Decrypt(_ context.Context, in *kms.DecryptInput, _ ...func(*kms.Options)) (*kms.DecryptOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.decrypts = append(f.decrypts, maps.Clone(in.EncryptionContext))
	if in.KeyId == nil {
		return nil, errors.New("fake kms: decrypt without a pinned key id")
	}
	prefix := []byte(*in.KeyId + "|" + canonical(in.EncryptionContext) + "|")
	if !bytes.HasPrefix(in.CiphertextBlob, prefix) {
		return nil, errors.New("fake kms: InvalidCiphertextException")
	}
	return &kms.DecryptOutput{Plaintext: bytes.TrimPrefix(in.CiphertextBlob, prefix)}, nil
}

func canonical(ec map[string]string) string {
	b, _ := encodeContext(ec)
	return string(b)
}

func TestKMSSealerPassesEncryptionContext(t *testing.T) {
	f := &fakeKMS{}
	s := NewKMSSealer(f, "alias/example-key")
	ctx := context.Background()
	ec := CredentialContext("t1", "u1")
	sealed, err := s.Seal(ctx, []byte("secret"), ec)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Open(ctx, sealed, ec)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "secret" {
		t.Fatalf("Open = %q", got)
	}
	want := map[string]string{"tenant": "t1", "user": "u1", "purpose": "assistant-credential"}
	if len(f.encrypts) != 1 || !maps.Equal(f.encrypts[0], want) {
		t.Fatalf("Encrypt context = %v, want %v", f.encrypts, want)
	}
	if len(f.decrypts) != 1 || !maps.Equal(f.decrypts[0], want) {
		t.Fatalf("Decrypt context = %v, want %v", f.decrypts, want)
	}
	if f.keyIDs[0] != "alias/example-key" {
		t.Fatalf("key id = %q", f.keyIDs[0])
	}
	if _, err := s.Open(ctx, sealed, CredentialContext("t1", "u2")); err == nil {
		t.Fatal("Open succeeded with the wrong encryption context")
	}
}

func TestKMSSealerReturnsErrors(t *testing.T) {
	f := &fakeKMS{err: errors.New("AccessDeniedException")}
	s := NewKMSSealer(f, "alias/example-key")
	if _, err := s.Seal(context.Background(), []byte("secret"), nil); err == nil {
		t.Fatal("Seal swallowed the KMS error")
	}
	if _, err := s.Open(context.Background(), []byte("x"), nil); err == nil {
		t.Fatal("Open swallowed the KMS error")
	}
}
