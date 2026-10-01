package wavemobile_test

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveengine"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemobile"
)

type recordingCallbacks struct {
	mu        sync.Mutex
	settings  []string
	lines     []string
	saved     []byte
	protected []int
}

func (c *recordingCallbacks) ApplySettings(settingsJSON string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.settings = append(c.settings, settingsJSON)
	return nil
}

func (c *recordingCallbacks) Log(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, line)
}

func (c *recordingCallbacks) SaveState(encoded []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.saved = encoded
}

func (c *recordingCallbacks) OpenAuthURL(string) {}

func (c *recordingCallbacks) ProtectSocket(fd int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.protected = append(c.protected, fd)
	return true
}

func TestACoreWithNoStateIsADeviceThatHasJoinedNothing(t *testing.T) {
	core, err := wavemobile.New("", "phone", false, "", &recordingCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	var status waveengine.Status
	if err := json.Unmarshal([]byte(core.Status()), &status); err != nil {
		t.Fatal(err)
	}
	if len(status.Waves) != 0 || status.Running {
		t.Fatalf("got %+v", status)
	}
}

// The state carries private keys, so a version this build cannot read has to
// say so rather than start with an empty one and silently rejoin everything.
func TestUnreadableStateIsRefused(t *testing.T) {
	if _, err := wavemobile.New(`{"version":99,"profiles":[]}`, "phone", false, "", &recordingCallbacks{}); err == nil {
		t.Fatal("a state from another version must be refused")
	}
	if _, err := wavemobile.New("not json", "phone", false, "", &recordingCallbacks{}); err == nil {
		t.Fatal("junk must be refused")
	}
}

func TestCallbacksAreRequired(t *testing.T) {
	if _, err := wavemobile.New("", "phone", false, "", nil); err == nil {
		t.Fatal("a core without callbacks can do nothing and must say so")
	}
}

// The tunnel descriptor is the one thing the platform hands over, and a bad one
// has to fail where somebody can see it.
func TestStartRefusesANonDescriptor(t *testing.T) {
	core, err := wavemobile.New("", "phone", false, "", &recordingCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	if err := core.Start(-1, false, 1280); err == nil {
		t.Fatal("-1 is not a descriptor")
	}
}

func TestUpstreamsAreACommaSeparatedList(t *testing.T) {
	// A slice of strings does not cross the gomobile boundary, so this is how
	// Android passes the resolvers it was using before we took over.
	callbacks := &recordingCallbacks{}
	if _, err := wavemobile.New("", "phone", true, "1.1.1.1, 8.8.8.8 ,", callbacks); err != nil {
		t.Fatal(err)
	}
}

func TestStatusIsAlwaysJSON(t *testing.T) {
	core, err := wavemobile.New("", "phone", false, "", &recordingCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	status := core.Status()
	if !strings.HasPrefix(status, "{") {
		t.Fatalf("status %q", status)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(status), &decoded); err != nil {
		t.Fatal(err)
	}
}
