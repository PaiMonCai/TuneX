package linktraffic

import (
	"context"
	"sort"

	"github.com/tunex/agent/internal/linkrunner"
)

type Store interface {
	TrafficSamples() ([]linkrunner.TrafficSample, error)
	AckTraffic([]linkrunner.TrafficSample) error
}

// Flush keeps one producer intact within a bounded request so the collector can
// reclaim a stopped process only after its complete final totals are committed.
func Flush(ctx context.Context, client Client, store Store) error {
	samples, err := store.TrafficSamples()
	if err != nil {
		return err
	}
	sort.Slice(samples, func(i, j int) bool {
		if samples[i].ProducerID != samples[j].ProducerID {
			return samples[i].ProducerID < samples[j].ProducerID
		}
		if samples[i].ForwardID != samples[j].ForwardID {
			return samples[i].ForwardID < samples[j].ForwardID
		}
		return samples[i].Date < samples[j].Date
	})
	for start := 0; start < len(samples); {
		end := start + 1
		for end < len(samples) && samples[end].ProducerID == samples[start].ProducerID {
			end++
		}
		if end-start > maxSamples {
			return ErrInvalid
		}
		accepted, err := client.Post(ctx, samples[start:end])
		if err != nil {
			return err
		}
		if err := store.AckTraffic(accepted); err != nil {
			return err
		}
		start = end
	}
	// No HTTP request exists for a stopped producer with no payload. Reclaim
	// only its authenticated empty manifest; the collector retains active or
	// nonzero/unacknowledged producers and performs durable ordered deletion.
	return store.AckTraffic(nil)
}
