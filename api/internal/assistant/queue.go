package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// TurnRef names one turn: the pending assistant message MessageID in the
// user's thread. It is all a queue carries; the worker reads the rest from
// the store.
type TurnRef struct {
	TenantID  string `json:"tenantId"`
	UserID    string `json:"userId"`
	ThreadID  string `json:"threadId"`
	MessageID string `json:"messageId"`
}

func (r TurnRef) complete() bool {
	return r.TenantID != "" && r.UserID != "" && r.ThreadID != "" && r.MessageID != ""
}

// Queue starts turns off the request path.
type Queue interface {
	Enqueue(ctx context.Context, ref TurnRef) error
}

// InProcessQueue runs each turn in a goroutine of this process (local
// development).
type InProcessQueue struct {
	run func(context.Context, TurnRef)
	wg  sync.WaitGroup
}

// NewInProcessQueue returns a queue that calls run for each turn in a new
// goroutine, with a context that outlives the request that enqueued it.
func NewInProcessQueue(run func(context.Context, TurnRef)) *InProcessQueue {
	return &InProcessQueue{run: run}
}

// Enqueue implements Queue.
func (q *InProcessQueue) Enqueue(_ context.Context, ref TurnRef) error {
	q.wg.Add(1)
	go func() {
		defer q.wg.Done()
		q.run(context.Background(), ref)
	}()
	return nil
}

// Wait blocks until every enqueued turn has finished.
func (q *InProcessQueue) Wait() { q.wg.Wait() }

// SQSAPI is the subset of *sqs.Client the queue uses.
type SQSAPI interface {
	SendMessage(ctx context.Context, in *sqs.SendMessageInput, optFns ...func(*sqs.Options)) (*sqs.SendMessageOutput, error)
}

var _ SQSAPI = (*sqs.Client)(nil)

type sqsQueue struct {
	client SQSAPI
	url    string
}

// NewSQSQueue returns a queue that sends each turn to the SQS queue at url
// as the JSON of its TurnRef.
func NewSQSQueue(client SQSAPI, url string) Queue { return &sqsQueue{client: client, url: url} }

func (q *sqsQueue) Enqueue(ctx context.Context, ref TurnRef) error {
	body, err := json.Marshal(ref)
	if err != nil {
		return err
	}
	s := string(body)
	if _, err := q.client.SendMessage(ctx, &sqs.SendMessageInput{QueueUrl: &q.url, MessageBody: &s}); err != nil {
		return fmt.Errorf("assistant: enqueue turn: %w", err)
	}
	return nil
}

// SQSHandler returns the Lambda handler of the turn queue. Each message is
// one TurnRef run with run; a run that fails is reported as a batch item
// failure so SQS delivers it again (the event source mapping must enable
// ReportBatchItemFailures). A message that is not a TurnRef is logged and
// dropped: retrying it cannot help.
func SQSHandler(run func(context.Context, TurnRef) error) func(context.Context, events.SQSEvent) (events.SQSEventResponse, error) {
	return func(ctx context.Context, ev events.SQSEvent) (events.SQSEventResponse, error) {
		var resp events.SQSEventResponse
		for _, m := range ev.Records {
			var ref TurnRef
			if err := json.Unmarshal([]byte(m.Body), &ref); err != nil || !ref.complete() {
				slog.Error("assistant: dropping a queue message that is not a turn", "messageId", m.MessageId)
				continue
			}
			if err := run(ctx, ref); err != nil {
				slog.Error("assistant: turn failed; it will be retried", "messageId", m.MessageId,
					"tenant", ref.TenantID, "thread", ref.ThreadID, "err", err)
				resp.BatchItemFailures = append(resp.BatchItemFailures, events.SQSBatchItemFailure{ItemIdentifier: m.MessageId})
			}
		}
		return resp, nil
	}
}
