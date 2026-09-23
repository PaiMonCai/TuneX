// Package fernet implements the Fernet symmetric encryption spec (AES-128-CBC +
// HMAC-SHA256) using only the standard library, byte-compatible with Python's
// `cryptography.fernet.Fernet`.
//
// Token wire format:
//
//	base64url( BASIC || MAC )
//	BASIC = 0x80 || timestamp(8B, big-endian, seconds) || iv(16B) || AES-128-CBC(PKCS7(plaintext))
//	MAC   = HMAC-SHA256(signing_key, BASIC)   // 32 bytes
//
// A Fernet key is 32 raw bytes, base64(-url) encoded to 44 chars:
//
//	signing_key    = key[0:16]
//	encryption_key = key[16:32]
package fernet

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	versionByte = 0x80
	minTokenLen = 1 + 8 + 16 + 16 + 32 // version + ts + iv + 1 block + mac
)

// ErrInvalidToken is returned for any malformed or unauthenticated token.
var ErrInvalidToken = errors.New("fernet: invalid token")

// DecodeKey decodes a 44-char base64(-url) Fernet key into its 32 raw bytes.
func DecodeKey(key string) ([]byte, error) {
	key = strings.TrimSpace(key)
	raw, err := decodeBase64Tolerant(key)
	if err != nil {
		return nil, fmt.Errorf("fernet: decode key: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("fernet: key must decode to 32 bytes, got %d", len(raw))
	}
	return raw, nil
}

// DecodeKeys decodes one or more keys (the first that authenticates wins on
// decrypt). Mirrors fernet.DecodeKeys semantics used by the original agent.
func DecodeKeys(keys ...string) ([][]byte, error) {
	out := make([][]byte, 0, len(keys))
	for _, k := range keys {
		raw, err := DecodeKey(k)
		if err != nil {
			return nil, err
		}
		out = append(out, raw)
	}
	if len(out) == 0 {
		return nil, errors.New("fernet: no keys provided")
	}
	return out, nil
}

// Decrypt verifies the MAC with key and returns the plaintext. Without TTL
// enforcement the embedded timestamp is informational (the agent does not use
// Fernet TTLs; expiry is carried inside the decrypted JSON instead).
func Decrypt(key []byte, token string) ([]byte, error) {
	raw, err := decodeBase64Tolerant(token)
	if err != nil {
		return nil, ErrInvalidToken
	}
	if len(raw) < minTokenLen {
		return nil, ErrInvalidToken
	}
	if raw[0] != versionByte {
		return nil, ErrInvalidToken
	}
	basic := raw[:len(raw)-32]
	mac := raw[len(raw)-32:]

	signingKey := key[:16]
	encKey := key[16:32]

	h := hmac.New(sha256.New, signingKey)
	h.Write(basic)
	expected := h.Sum(nil)
	if !hmac.Equal(expected, mac) {
		return nil, ErrInvalidToken
	}

	iv := basic[9:25]
	ciphertext := basic[25:]
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil, ErrInvalidToken
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, ErrInvalidToken
	}
	plaintext := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plaintext, ciphertext)
	return pkcs7Unpad(plaintext)
}

// DecryptMulti tries each key in order and returns the first success.
func DecryptMulti(keys [][]byte, token string) ([]byte, error) {
	var lastErr error = ErrInvalidToken
	for _, k := range keys {
		pt, err := Decrypt(k, token)
		if err == nil {
			return pt, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// Encrypt produces a Fernet token for plaintext using key, using the current
// time as the embedded timestamp.
func Encrypt(key []byte, plaintext []byte) (string, error) {
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key[16:32])
	if err != nil {
		return "", err
	}
	padded := pkcs7Pad(plaintext, aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)

	basic := make([]byte, 0, 1+8+16+len(ciphertext))
	basic = append(basic, versionByte)
	ts := make([]byte, 8)
	putUint64BE(ts, uint64(time.Now().Unix()))
	basic = append(basic, ts...)
	basic = append(basic, iv...)
	basic = append(basic, ciphertext...)

	h := hmac.New(sha256.New, key[:16])
	h.Write(basic)
	mac := h.Sum(nil)

	return base64.RawURLEncoding.EncodeToString(append(basic, mac...)), nil
}

// ---------------------------------------------------------------------------

func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - len(data)%blockSize
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}

func pkcs7Unpad(data []byte) ([]byte, error) {
	n := len(data)
	if n == 0 || n%aes.BlockSize != 0 {
		return nil, ErrInvalidToken
	}
	pad := int(data[n-1])
	if pad == 0 || pad > aes.BlockSize || pad > n {
		return nil, ErrInvalidToken
	}
	for i := n - pad; i < n; i++ {
		if int(data[i]) != pad {
			return nil, ErrInvalidToken
		}
	}
	return data[:n-pad], nil
}

func putUint64BE(b []byte, v uint64) {
	for i := 7; i >= 0; i-- {
		b[i] = byte(v)
		v >>= 8
	}
}

// decodeBase64Tolerant accepts padded or unpadded, and both the URL-safe
// (`-_`) and standard (`+/`) alphabets. The real config key contains `/`.
func decodeBase64Tolerant(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, ErrInvalidToken
	}
	// Try the direct decoders first.
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	// Normalise alphabet then retry.
	norm := strings.NewReplacer("+", "-", "/", "_").Replace(strings.TrimRight(s, "="))
	if b, err := base64.RawURLEncoding.DecodeString(norm); err == nil {
		return b, nil
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return nil, ErrInvalidToken
}
