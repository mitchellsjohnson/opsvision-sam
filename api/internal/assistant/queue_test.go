package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

var testRef = TurnRef{TenantID: "t1", UserID: "u1", ThreadID: "th-1", MessageID: "m-2"}

func TestInProcessQueueRunsTheTurn(t *testing.T) {
	got := make(chan TurnRef, 1)
	var runCtx context.Context
	q := NewInProcessQueue(func(ctx context.Context, ref TurnRef) {
		runCtx = ctx
		got <- ref
	})
	ctx, cancel := context.WithCancel(context.Background())
	if err := q.Enqueue(ctx, testRef); err != nil {
		t.Fatal(err)
	}
	cancel() // the request ends; the turn must not be cancelled with it
	select {
	case ref := <-got:
		if ref != testRef {
			t.Fatalf("ran %+v, want %+v", ref, testRef)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the turn never ran")
	}
	q.Wait()
	if runCtx.Err() != nil {
		t.Fatal("the turn's context was cancelled with the request's")
	}
}

type fakeSQS struct {
	in  *sqs.SendMessageInput
	err error
}

func (f *fakeSQS) SendMessage(_ context.Context, in *sqs.SendMessageInput, _ ...func(*sqs.Options)) (*sqs.SendMessageOutput, error) {
	f.in = in
	return &sqs.SendMessageOutput{}, f.err
}

func TestSQSQueueSendsTheTurnRefAsJSON(t *testing.T) {
	f := &fakeSQS{}
	q := NewSQSQueue(f, "https://sqs.example.test/123/turns")
	if err := q.Enqueue(context.Background(), testRef); err != nil {
		t.Fatal(err)
	}
	if f.in == nil || *f.in.QueueUrl != "https://sqs.example.test/123/turns" {
		t.Fatalf("SendMessage input = %+v", f.in)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(*f.in.MessageBody), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"tenantId": "t1", "userId": "u1", "threadId": "th-1", "messageId": "m-2"}
	if len(body) != len(want) {
		t.Fatalf("body = %v, want %v", body, want)
	}
	for k, v := range want {
		if body[k] != v {
			t.Fatalf("body = %v, want %v", body, want)
		}
	}

	f.err = errors.New("boom")
	if err := q.Enqueue(context.Background(), testRef); err == nil {
		t.Fatal("a send failure was not returned")
	}
}

func TestSQSHandler(t *testing.T) {
	body, _ := json.Marshal(testRef)
	var ran []TurnRef
	fail := false
	h := SQSHandler(func(_ context.Context, ref TurnRef) error {
		ran = append(ran, ref)
		if fail {
			return errors.New("store down")
		}
		return nil
	})
	ev := events.SQSEvent{Records: []events.SQSMessage{{MessageId: "msg-1", Body: string(body)}}}

	resp, err := h(context.Background(), ev)
	if err != nil || len(resp.BatchItemFailures) != 0 || len(ran) != 1 || ran[0] != testRef {
		t.Fatalf("ok turn: resp %+v, err %v, ran %+v", resp, err, ran)
	}

	fail = true
	resp, err = h(context.Background(), ev)
	if err != nil || len(resp.BatchItemFailures) != 1 || resp.BatchItemFailures[0].ItemIdentifier != "msg-1" {
		t.Fatalf("failed turn: resp %+v, err %v, want msg-1 reported for retry", resp, err)
	}

	ran = nil
	bad := events.SQSEvent{Records: []events.SQSMessage{{MessageId: "msg-2", Body: "not json"}, {MessageId: "msg-3", Body: `{"tenantId":"t1"}`}}}
	resp, err = h(context.Background(), bad)
	if err != nil || len(resp.BatchItemFailures) != 0 || len(ran) != 0 {
		t.Fatalf("malformed: resp %+v, err %v, ran %+v; want dropped, not retried", resp, err, ran)
	}
}
