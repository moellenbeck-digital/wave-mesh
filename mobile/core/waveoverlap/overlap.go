// Package waveoverlap guards against two waves claiming the same thing.
//
// On the desktop this was about addresses alone: a control server hands every
// wave a block of its own, so the waves on one server never collide, but two
// independent servers know nothing about each other and can both hand out
// 10.64.0.0/16 -- and then the device ends up with two host routes for the same
// address, one of which silently wins.
//
// On a phone it is also about keys, and that is not a nicety. The waves share
// one UDP socket there, and a discovery packet carries its sender's key in the
// clear: the lookup that decides which peer a packet belongs to therefore
// reaches across every wave at once. A malicious control server could otherwise
// announce a peer holding another wave's disco key and hang itself in that
// lookup. So a key may belong to one wave only, exactly as an address may.
//
// There is no repair for either from here: renumbering a wave is the server's
// business, and rotating a key is the other node's. So the second wave is
// refused, by name, and the first keeps running untouched.
package waveoverlap

import (
	"fmt"
	"net/netip"
	"strings"
)

// Claim is everything one wave holds on this device.
type Claim struct {
	// The wave, named by its control server. There is no second name.
	ControlURL string
	CIDRs      []string
	NodeKeys   []string
	DiscoKeys  []string
}

// Conflict says what collides with what, and with whom.
type Conflict struct {
	// "address", "node key" or "disco key".
	Kind string
	// What the wave being brought up wants.
	Wanted string
	// The wave that already holds it, and the thing it holds.
	HeldBy string
	Held   string
}

func (c Conflict) Error() string { return c.Describe("this wave") }

// Describe is what to tell the user, naming both waves so they know where to
// look, and saying which way the repair goes.
func (c Conflict) Describe(wave string) string {
	if c.Kind == "address" {
		return fmt.Sprintf(
			"%s wants %s, which %s already uses (%s). Two waves cannot share an address on one device -- "+
				"give one of them a different range on its control server, then try again. %s keeps running.",
			wave, c.Wanted, c.HeldBy, c.Held, c.HeldBy)
	}
	return fmt.Sprintf(
		"%s announces a %s that %s already uses (%s...). Two waves cannot share a key on one device: "+
			"the waves share a socket here, and discovery would no longer be able to tell them apart. "+
			"%s keeps running.",
		wave, c.Kind, c.HeldBy, short(c.Held), c.HeldBy)
}

func short(key string) string {
	if len(key) > 8 {
		return key[:8]
	}
	return key
}

// prefixOf reads a CIDR, or a bare address as its own single-host prefix.
func prefixOf(cidr string) (netip.Prefix, bool) {
	if strings.Contains(cidr, "/") {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil {
			return netip.Prefix{}, false
		}
		return prefix.Masked(), true
	}
	address, err := netip.ParseAddr(cidr)
	if err != nil {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(address, address.BitLen()), true
}

// Find returns the first thing `wanted` shares with something already
// configured, or nil when the two are disjoint.
//
// Unparseable input claims nothing. That is deliberate: a range this version
// cannot read is not a licence to refuse a wave that works.
func Find(wanted Claim, held []Claim) *Conflict {
	mine := make([]netip.Prefix, 0, len(wanted.CIDRs))
	mineText := make([]string, 0, len(wanted.CIDRs))
	for _, cidr := range wanted.CIDRs {
		if prefix, ok := prefixOf(cidr); ok {
			mine = append(mine, prefix)
			mineText = append(mineText, cidr)
		}
	}

	for _, claim := range held {
		if claim.ControlURL == wanted.ControlURL {
			continue // the same wave coming up again holds against itself
		}
		for _, cidr := range claim.CIDRs {
			theirs, ok := prefixOf(cidr)
			if !ok {
				continue
			}
			for i, prefix := range mine {
				if prefix.Overlaps(theirs) {
					return &Conflict{Kind: "address", Wanted: mineText[i], HeldBy: claim.ControlURL, Held: cidr}
				}
			}
		}
		if conflict := findKey("node key", wanted.NodeKeys, claim.NodeKeys, claim.ControlURL); conflict != nil {
			return conflict
		}
		if conflict := findKey("disco key", wanted.DiscoKeys, claim.DiscoKeys, claim.ControlURL); conflict != nil {
			return conflict
		}
	}
	return nil
}

func findKey(kind string, wanted, held []string, heldBy string) *Conflict {
	if len(wanted) == 0 || len(held) == 0 {
		return nil
	}
	set := make(map[string]struct{}, len(held))
	for _, key := range held {
		set[key] = struct{}{}
	}
	for _, key := range wanted {
		if _, clash := set[key]; clash {
			return &Conflict{Kind: kind, Wanted: short(key) + "...", HeldBy: heldBy, Held: key}
		}
	}
	return nil
}

// ClaimFromNetmap gathers what a wave would hold: its own addresses, every
// address it wants routed, and every key discovery has to tell apart.
func ClaimFromNetmap(controlURL string, addresses []string, allowedIPs [][]string, nodeKeys, discoKeys []string) Claim {
	claim := Claim{ControlURL: controlURL, NodeKeys: nodeKeys, DiscoKeys: discoKeys}
	claim.CIDRs = append(claim.CIDRs, addresses...)
	for _, group := range allowedIPs {
		claim.CIDRs = append(claim.CIDRs, group...)
	}
	return claim
}
