// Package config resolves runtime settings from a git-ignored config file and
// the environment. The environment always wins so a secret never has to be
// written to disk.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
)

// Environment variables recognized by cue-note.
const (
	EnvAPIKey    = "CUE_NOTE_API_KEY"
	EnvAddr      = "CUE_NOTE_ADDR"
	EnvDataFile  = "CUE_NOTE_DATA_FILE"
	EnvUIAddr    = "CUE_NOTE_UI_ADDR"
	EnvAPITarget = "CUE_NOTE_API_URL"
)

// Defaults for a local-only deployment.
const (
	DefaultAddr     = "127.0.0.1:8765"
	DefaultDataFile = "data/cue-note.json"
	DefaultUIAddr   = "127.0.0.1:8766"
	DefaultAPIURL   = "http://127.0.0.1:8765"
)

// File is the on-disk config shape. It is optional; every field may be
// supplied through the environment instead.
type File struct {
	APIKey   string `json:"apiKey"`
	Addr     string `json:"addr"`
	DataFile string `json:"dataFile"`
	UIAddr   string `json:"uiAddr"`
	APIURL   string `json:"apiUrl"`
}

// Config is the resolved settings set.
type Config struct {
	APIKey   string
	Addr     string
	DataFile string
	UIAddr   string
	APIURL   string
}

// Load reads the optional config file at path, then applies environment
// overrides and defaults. A missing file at an unspecified path is not an
// error; a missing file at an explicitly requested path is.
func Load(path string) (Config, error) {
	var file File
	if path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				return Config{}, fmt.Errorf("config: read %s: %w", path, err)
			}
			return Config{}, fmt.Errorf("config: %s does not exist", path)
		}
		if err := json.Unmarshal(raw, &file); err != nil {
			return Config{}, fmt.Errorf("config: parse %s: %w", path, err)
		}
	}
	cfg := Config{
		APIKey:   firstNonEmpty(os.Getenv(EnvAPIKey), file.APIKey),
		Addr:     firstNonEmpty(os.Getenv(EnvAddr), file.Addr, DefaultAddr),
		DataFile: firstNonEmpty(os.Getenv(EnvDataFile), file.DataFile, DefaultDataFile),
		UIAddr:   firstNonEmpty(os.Getenv(EnvUIAddr), file.UIAddr, DefaultUIAddr),
		APIURL:   firstNonEmpty(os.Getenv(EnvAPITarget), file.APIURL, DefaultAPIURL),
	}
	return cfg, nil
}

// IsLoopback reports whether addr binds only to a loopback interface.
func IsLoopback(addr string) bool {
	host := addr
	if idx := strings.LastIndex(addr, ":"); idx >= 0 {
		host = addr[:idx]
	}
	host = strings.Trim(host, "[]")
	switch host {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
