package waveengine

import (
	"net/url"
	"strings"
)

// NormaliseControlURL turns what somebody typed into a control server address,
// or reports that it is not one.
//
// A bare host is what a profile list prints, so that is what gets typed back --
// and taken verbatim it becomes an enrolment whose address is not a URL at all:
// it takes a slot, fails forever, and sits next to the real one in the list.
// Anything without a scheme gets https; what still does not parse is refused
// rather than stored. The trailing slash goes, so the same server typed two
// ways stays one enrolment -- the control server strips it too.
func NormaliseControlURL(input string) (string, bool) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return "", false
	}
	candidate := trimmed
	if !hasScheme(trimmed) {
		candidate = "https://" + trimmed
	}
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.Host == "" {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	return strings.TrimSuffix(parsed.String(), "/"), true
}

func hasScheme(value string) bool {
	separator := strings.Index(value, "://")
	if separator <= 0 {
		return false
	}
	for i := 0; i < separator; i++ {
		c := value[i]
		letter := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		digit := c >= '0' && c <= '9'
		if !letter && !digit && c != '+' && c != '.' && c != '-' {
			return false
		}
	}
	return true
}

// WaveLabel shortens a control URL for display: host and port, never a key.
func WaveLabel(controlURL string) string {
	parsed, err := url.Parse(controlURL)
	if err != nil || parsed.Host == "" {
		return controlURL
	}
	return parsed.Host
}
