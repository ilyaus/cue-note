// Command webui serves the cue-note web UI and proxies its API calls to the
// cue-note API server, attaching the API key server-side so the browser never
// receives it.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ilyaus/cue-note/internal/api"
	"github.com/ilyaus/cue-note/internal/config"
	"github.com/ilyaus/cue-note/web"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "cue-note-ui: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		configPath = flag.String("config", "", "path to a JSON config file (optional; environment always wins)")
		addr       = flag.String("addr", "", "listen address for the UI (default "+config.DefaultUIAddr+")")
		apiURL     = flag.String("api-url", "", "base URL of the cue-note API (default "+config.DefaultAPIURL+")")
	)
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	if *addr != "" {
		cfg.UIAddr = *addr
	}
	if *apiURL != "" {
		cfg.APIURL = *apiURL
	}

	target, err := url.Parse(cfg.APIURL)
	if err != nil {
		return fmt.Errorf("parse api url %q: %w", cfg.APIURL, err)
	}
	if target.Scheme == "" || target.Host == "" {
		return fmt.Errorf("api url %q must include a scheme and host", cfg.APIURL)
	}

	assets, err := web.Assets()
	if err != nil {
		return fmt.Errorf("load ui assets: %w", err)
	}

	logger := log.New(os.Stderr, "", log.LstdFlags|log.LUTC)

	proxy := httputil.NewSingleHostReverseProxy(target)
	baseDirector := proxy.Director
	proxy.Director = func(r *http.Request) {
		// /api/prompts -> <api>/v1/prompts, with the key added server-side.
		r.URL.Path = "/v1/" + strings.TrimPrefix(r.URL.Path, "/api/")
		baseDirector(r)
		if cfg.APIKey != "" {
			r.Header.Set(api.APIKeyHeader, cfg.APIKey)
		}
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		logger.Printf("cue-note-ui: proxy to %s failed: %v", target, err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"code":"upstream_unavailable","message":"cue-note API is unreachable"}}`))
	}

	mux := http.NewServeMux()
	mux.Handle("/api/", proxy)
	mux.Handle("/", http.FileServer(http.FS(assets)))

	httpServer := &http.Server{
		Addr:              cfg.UIAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          logger,
	}

	if !config.IsLoopback(cfg.UIAddr) {
		logger.Printf("cue-note-ui: WARNING listening on non-loopback address %s", cfg.UIAddr)
	}
	if cfg.APIKey == "" {
		logger.Printf("cue-note-ui: WARNING no API key configured; requests will fail unless the API runs with --disable-auth")
	}
	logger.Printf("cue-note-ui: listening on http://%s (proxying to %s)", cfg.UIAddr, target)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("serve on %s: %w", cfg.UIAddr, err)
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		return <-errCh
	}
}
