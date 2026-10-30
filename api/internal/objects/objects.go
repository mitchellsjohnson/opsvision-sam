// Package objects is the blob store behind imports: the uploaded workbook and
// the change set parsed from it.
//
// Production uses S3 (NewS3): the browser uploads straight to the bucket with
// a presigned URL, so the file never passes through the API. Development and
// tests use Mem, whose presigned URLs point at the dev server.
package objects

import (
	"context"
	"errors"
	"io"
	"time"
)

const (
	// ContentTypeXLSX is the only content type of an uploaded workbook.
	ContentTypeXLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	// MaxUploadBytes is the largest workbook the API accepts.
	MaxUploadBytes int64 = 20 << 20
	// UploadTTL is how long a presigned upload URL stays valid.
	UploadTTL = 15 * time.Minute
)

// ErrNotFound is returned by Get when the key does not exist.
var ErrNotFound = errors.New("objects: not found")

// Store keeps objects by key. Keys are tenant-prefixed by the caller
// (t/<tenantId>/...); a Store does no access control of its own.
type Store interface {
	// PresignPut returns a URL that accepts one PUT of an object at key with
	// the given Content-Type, until ttl has passed. maxBytes is the largest
	// size the caller will accept. A store that cannot enforce it at upload
	// time (S3 presigned PUTs cannot) leaves the check to the reader.
	PresignPut(ctx context.Context, key, contentType string, maxBytes int64, ttl time.Duration) (url string, err error)
	// Get opens the object and reports its size in bytes. The caller closes
	// the reader. A missing key returns ErrNotFound.
	Get(ctx context.Context, key string) (io.ReadCloser, int64, error)
	// Put stores body at key, replacing any existing object. Objects are
	// encrypted at rest.
	Put(ctx context.Context, key, contentType string, body []byte) error
}
