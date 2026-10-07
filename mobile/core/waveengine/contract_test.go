package waveengine

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

var updateContract = flag.Bool("update", false, "rewrite testdata/status.json from the current shape")

// The status is the other structure Swift decodes by hand, every second. A
// field that changes shape here makes the app's decoder fail and the screen
// stop updating, with nothing to see anywhere -- so, as for the settings, the
// shape is a file, and the iOS tests decode this very file.
func TestStatusJSONMatchesTheContractFile(t *testing.T) {
	engine, _ := newTestEngine(t)
	entry := addWave(t, engine, "https://a.example")
	netmap := netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1",
		testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2"))
	netmap.Services = append(netmap.Services, waveproto.Service{
		Name: "grafana", DNSName: "grafana.a.wave.example.com", IPv4: "10.77.0.9",
		URL: "https://grafana.a.wave.example.com",
	})
	if err := engine.applyNetmap(entry, netmap); err != nil {
		t.Fatal(err)
	}
	paused, err := NewProfile("https://b.example")
	if err != nil {
		t.Fatal(err)
	}
	paused.NetmapPublicKey = "pinned"
	paused.AutoStart = false
	removed, err := NewProfile("https://c.example")
	if err != nil {
		t.Fatal(err)
	}
	removed.NetmapPublicKey = "pinned"
	removed.Removed = "node-removed"
	removed.AutoStart = false
	engine.mu.Lock()
	engine.state.Profiles = append(engine.state.Profiles, entry.profile, paused, removed)
	engine.mu.Unlock()

	status := engine.Status()
	status.Port = 41641 // the test socket takes whatever port is free
	encoded, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	path := filepath.Join("testdata", "status.json")
	if *updateContract {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, want) {
		t.Fatalf("the status JSON changed shape; update the Swift reader, then run\n  go test ./waveengine -run Contract -update\ngot:\n%s", encoded)
	}
}
