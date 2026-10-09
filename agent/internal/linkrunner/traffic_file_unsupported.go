//go:build !linux && !windows

package linkrunner

import "os"

// Native Agent builds must not acquire an unsafe os.Open fallback. Managed FXP
// traffic is intentionally unsupported outside the Linux/Windows targets.
func openTrafficFile(string) (*os.File, error) { return nil, ErrTraffic }
