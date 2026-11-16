// Package assistant is SAM, the in-app assistant: sealing users' provider
// keys at rest and calling the model provider with them.
package assistant

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/kms"
)

// PurposeAssistantCredential is the purpose in the encryption context of a
// sealed provider key.
const PurposeAssistantCredential = "assistant-credential"

// CredentialContext is the encryption context a user's provider key is sealed
// under, so a sealed key opens only for the tenant and user it belongs to.
func CredentialContext(tenantID, userID string) map[string]string {
	return map[string]string{"tenant": tenantID, "user": userID, "purpose": PurposeAssistantCredential}
}

// Sealer encrypts secrets at rest. The encryption context ec is
// authenticated but not secret: Open fails unless it gets the same context
// Seal did.
type Sealer interface {
	Seal(ctx context.Context, plaintext []byte, ec map[string]string) ([]byte, error)
	Open(ctx context.Context, sealed []byte, ec map[string]string) ([]byte, error)
}

// KMSAPI is the part of the AWS KMS client a KMS sealer uses.
type KMSAPI interface {
	Encrypt(ctx context.Context, in *kms.EncryptInput, optFns ...func(*kms.Options)) (*kms.EncryptOutput, error)
	Decrypt(ctx context.Context, in *kms.DecryptInput, optFns ...func(*kms.Options)) (*kms.DecryptOutput, error)
}

// encodeContext is the canonical encoding of an encryption context, used as
// AES-GCM additional data: JSON with sorted keys. A nil context encodes as an
// empty one.
func encodeContext(ec map[string]string) ([]byte, error) {
	if ec == nil {
		ec = map[string]string{}
	}
	return json.Marshal(ec)
}

type aesSealer struct{ aead cipher.AEAD }

// NewAESSealer returns a Sealer using AES-256-GCM with key, which must be 32
// bytes. Each seal uses a random nonce; the output is the nonce followed by
// the ciphertext and tag. It is for local development and tests; in AWS use
// NewKMSSealer.
func NewAESSealer(key []byte) (Sealer, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("assistant: the credential key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &aesSealer{aead: aead}, nil
}

func (s *aesSealer) Seal(_ context.Context, plaintext []byte, ec map[string]string) ([]byte, error) {
	aad, err := encodeContext(ec)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, s.aead.NonceSize(), s.aead.NonceSize()+len(plaintext)+s.aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.aead.Seal(nonce, nonce, plaintext, aad), nil
}

func (s *aesSealer) Open(_ context.Context, sealed []byte, ec map[string]string) ([]byte, error) {
	aad, err := encodeContext(ec)
	if err != nil {
		return nil, err
	}
	n := s.aead.NonceSize()
	if len(sealed) < n+s.aead.Overhead() {
		return nil, errors.New("assistant: sealed value is too short")
	}
	plain, err := s.aead.Open(nil, sealed[:n], sealed[n:], aad)
	if err != nil {
		return nil, errors.New("assistant: cannot open the sealed value")
	}
	return plain, nil
}

type kmsSealer struct {
	client KMSAPI
	keyID  string
}

// NewKMSSealer returns a Sealer that encrypts with the KMS key keyID (a key
// ID, ARN or alias) under the encryption context, and decrypts only with that
// key.
func NewKMSSealer(client KMSAPI, keyID string) Sealer {
	return &kmsSealer{client: client, keyID: keyID}
}

func (s *kmsSealer) Seal(ctx context.Context, plaintext []byte, ec map[string]string) ([]byte, error) {
	out, err := s.client.Encrypt(ctx, &kms.EncryptInput{KeyId: &s.keyID, Plaintext: plaintext, EncryptionContext: ec})
	if err != nil {
		return nil, fmt.Errorf("assistant: kms encrypt: %w", err)
	}
	return out.CiphertextBlob, nil
}

func (s *kmsSealer) Open(ctx context.Context, sealed []byte, ec map[string]string) ([]byte, error) {
	out, err := s.client.Decrypt(ctx, &kms.DecryptInput{KeyId: &s.keyID, CiphertextBlob: sealed, EncryptionContext: ec})
	if err != nil {
		return nil, fmt.Errorf("assistant: kms decrypt: %w", err)
	}
	return out.Plaintext, nil
}
