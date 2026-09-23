// Package license verifies the license token the control plane returns in the
// register ACK.
//
// The original agent validates the license entirely client-side (this is a
// known weakness of the upstream design, reproduced here for compatibility):
//
//	Fernet-decrypt with the hard-coded license key
//	  -> expired_at (int64 unix seconds) must not be in the past
//	  -> site_url must match the agent's configured server URL
//	  -> type must be one of {business, personal}
package license

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/tunex/agent/internal/fernet"
)

// There is no default key. Each TuneX installation generates its own Fernet
// keys and injects them through the environment, so a leaked key from one
// deployment can never authenticate against another.
const (
	// EnvConfigKey names the environment variable that carries the config key.
	EnvConfigKey = "TUNEX_CONFIG_KEY"
	// EnvLicenseKey names the environment variable that carries the license key.
	EnvLicenseKey = "TUNEX_LICENSE_KEY"

	errNoConfigKey  = "license: TUNEX_CONFIG_KEY is required (no default key is shipped)"
	errNoLicenseKey = "license: TUNEX_LICENSE_KEY is required (no default key is shipped)"
)

// Type is the license type enum.
type Type string

const (
	TypeBusiness Type = "business"
	TypePersonal Type = "personal"
)

// Payload is the decrypted license JSON. Field names match the Go struct in the
// original agent (snake_case).
type Payload struct {
	ExpiredAt int64  `json:"expired_at"`
	Type      Type   `json:"type"`
	SiteURL   string `json:"site_url"`
}

// Info is a decoded, validated license.
type Info struct {
	Payload Payload
	Expired bool
	// SiteURLMatches is true when the token's site_url equals the expected URL.
	SiteURLMatches bool
}

// Verify decrypts token with key and validates its fields against siteURL.
// It returns an error only when the token cannot be decrypted/parsed; expiry and
// site-url mismatches are reported via the returned Info so the caller decides.
func Verify(token, key, siteURL string) (*Info, error) {
	if key == "" {
		return nil, errors.New(errNoLicenseKey)
	}
	raw, err := fernet.DecodeKey(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := fernet.Decrypt(raw, token)
	if err != nil {
		return nil, fmt.Errorf("license: decrypt failed: %w", err)
	}
	var p Payload
	if err := json.Unmarshal(plaintext, &p); err != nil {
		return nil, fmt.Errorf("license: invalid payload: %w", err)
	}
	if p.Type != TypeBusiness && p.Type != TypePersonal {
		return nil, fmt.Errorf("license: invalid type %q", p.Type)
	}
	return &Info{
		Payload:        p,
		Expired:        p.ExpiredAt > 0 && p.ExpiredAt < time.Now().Unix(),
		SiteURLMatches: p.SiteURL == siteURL,
	}, nil
}

// DecodeConfigKey returns the raw bytes of key, which must be supplied by the
// deployment. An empty key is an error: TuneX ships no built-in key.
func DecodeConfigKey(key string) ([]byte, error) {
	if key == "" {
		return nil, errors.New(errNoConfigKey)
	}
	return fernet.DecodeKey(key)
}

// DecodeLicenseKey returns the raw bytes of key, which must be supplied by the
// deployment. An empty key is an error: TuneX ships no built-in key.
func DecodeLicenseKey(key string) ([]byte, error) {
	if key == "" {
		return nil, errors.New(errNoLicenseKey)
	}
	return fernet.DecodeKey(key)
}
