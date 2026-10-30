package objects

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// S3 is a Store over one S3 bucket.
type S3 struct {
	client  *s3.Client
	presign *s3.PresignClient
	bucket  string
}

var _ Store = (*S3)(nil)

// NewS3 returns a Store over bucket. Build the client with NewS3Client: a
// default client signs a checksum of the empty body into presigned PUT URLs,
// which makes every real upload fail.
func NewS3(client *s3.Client, bucket string) *S3 {
	return &S3{client: client, presign: s3.NewPresignClient(client), bucket: bucket}
}

// NewS3Client builds an S3 client from cfg that is safe for presigning PUTs:
// request checksums are computed only where S3 requires them. opts adjust the
// client (tests point it at a fake endpoint).
func NewS3Client(cfg aws.Config, opts ...func(*s3.Options)) *s3.Client {
	return s3.NewFromConfig(cfg, append([]func(*s3.Options){func(o *s3.Options) {
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
	}}, opts...)...)
}

// PresignPut implements Store. The URL is valid for ttl and requires the
// request's Content-Type header to equal contentType (it is a signed header).
// S3 cannot bound the size of a presigned PUT, so maxBytes is not enforced
// here: readers check the size, and the bucket should have a lifecycle rule
// that expires stray uploads.
func (s *S3) PresignPut(ctx context.Context, key, contentType string, _ int64, ttl time.Duration) (string, error) {
	out, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      &s.bucket,
		Key:         &key,
		ContentType: &contentType,
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("objects: presign %s: %w", key, err)
	}
	return out.URL, nil
}

// Get implements Store.
func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		var nsk *types.NoSuchKey
		var apiErr smithy.APIError
		if errors.As(err, &nsk) || (errors.As(err, &apiErr) && (apiErr.ErrorCode() == "NoSuchKey" || apiErr.ErrorCode() == "NotFound")) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, fmt.Errorf("objects: get %s: %w", key, err)
	}
	size := int64(-1)
	if out.ContentLength != nil {
		size = *out.ContentLength
	}
	return out.Body, size, nil
}

// Put implements Store, with server-side encryption (SSE-S3, AES256).
func (s *S3) Put(ctx context.Context, key, contentType string, body []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:               &s.bucket,
		Key:                  &key,
		ContentType:          &contentType,
		Body:                 bytes.NewReader(body),
		ServerSideEncryption: types.ServerSideEncryptionAes256,
	})
	if err != nil {
		return fmt.Errorf("objects: put %s: %w", key, err)
	}
	return nil
}
