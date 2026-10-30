package memstore_test

import (
	"testing"

	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
	"opsvision/internal/store/storetest"
)

func TestContract(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store { return memstore.New() })
}
