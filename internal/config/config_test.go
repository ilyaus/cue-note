package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.APIKey != "" {
		t.Errorf("API key = %q, want empty", cfg.APIKey)
	}
	if cfg.Addr != DefaultAddr || cfg.DataFile != DefaultDataFile || cfg.UIAddr != DefaultUIAddr || cfg.APIURL != DefaultAPIURL {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadFileThenEnvironmentWins(t *testing.T) {
	clearEnv(t)
	path := filepath.Join(t.TempDir(), "config.json")
	body := `{"apiKey":"from-file","addr":"127.0.0.1:1111","dataFile":"file.json","uiAddr":"127.0.0.1:2222","apiUrl":"http://127.0.0.1:1111"}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.APIKey != "from-file" || cfg.Addr != "127.0.0.1:1111" || cfg.DataFile != "file.json" {
		t.Fatalf("file values not applied: %+v", cfg)
	}

	t.Setenv(EnvAPIKey, "from-env")
	t.Setenv(EnvAddr, "127.0.0.1:3333")
	cfg, err = Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.APIKey != "from-env" || cfg.Addr != "127.0.0.1:3333" {
		t.Fatalf("environment did not win: %+v", cfg)
	}
	if cfg.DataFile != "file.json" {
		t.Errorf("unset environment overwrote file value: %q", cfg.DataFile)
	}
}

func TestLoadRejectsMissingAndMalformedFile(t *testing.T) {
	clearEnv(t)
	if _, err := Load(filepath.Join(t.TempDir(), "absent.json")); err == nil {
		t.Error("expected error for explicitly requested missing file")
	}
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Error("expected error for malformed file")
	}
}

func TestIsLoopback(t *testing.T) {
	loopback := []string{"127.0.0.1:8765", "localhost:8765", "[::1]:8765"}
	for _, addr := range loopback {
		if !IsLoopback(addr) {
			t.Errorf("%s should be loopback", addr)
		}
	}
	for _, addr := range []string{":8765", "0.0.0.0:8765", "192.168.1.5:8765"} {
		if IsLoopback(addr) {
			t.Errorf("%s should not be loopback", addr)
		}
	}
}

func clearEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{EnvAPIKey, EnvAddr, EnvDataFile, EnvUIAddr, EnvAPITarget} {
		t.Setenv(key, "")
	}
}
