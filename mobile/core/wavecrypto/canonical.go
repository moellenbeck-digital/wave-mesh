package wavecrypto

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// CanonicalJSON re-encodes a JSON document the one way both sides agree on:
// object keys sorted, no whitespace, numbers and strings spelled exactly as
// JavaScript's JSON.stringify spells them.
//
// It takes raw bytes rather than a struct on purpose, and that is the whole
// reason netmap verification is simpler here than in TypeScript. The signature
// covers what the server sent, so anything that drops an unknown field or
// invents a missing one canonicalises something else and reports a perfectly
// good netmap as forged -- the failure that made every schema below Netmap a
// looseObject without defaults. Canonicalising the bytes cannot do either:
// what was not read cannot be lost, because nothing is read.
func CanonicalJSON(raw []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := writeCanonical(&out, value); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// CanonicalJSONOf marshals a value and canonicalises the result. Used for
// things this side builds; a document that arrived from elsewhere goes through
// CanonicalJSON so its bytes are never re-interpreted.
func CanonicalJSONOf(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return CanonicalJSON(raw)
}

func writeCanonical(out *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(v))
	case json.Number:
		number, err := v.Float64()
		if err != nil {
			return fmt.Errorf("not a number: %q", v.String())
		}
		out.WriteString(jsNumber(number))
	case string:
		writeJSString(out, v)
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := writeCanonical(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		// Byte order, which is what JavaScript's `<` gives for the ASCII keys
		// this protocol uses.
		sort.Strings(keys)
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			writeJSString(out, key)
			out.WriteByte(':')
			if err := writeCanonical(out, v[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("cannot canonicalise %T", value)
	}
	return nil
}

// jsNumber spells a float the way JavaScript does.
//
// encoding/json is close but not identical, and the difference would only show
// up as a signature that does not verify. In practice every number in a netmap
// is a small integer -- a version, a port -- which is the case this gets
// exactly right; the rest is here so an added field cannot quietly break it.
func jsNumber(f float64) string {
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return "null" // what JSON.stringify does with them
	}
	abs := math.Abs(f)
	if f == 0 || (abs >= 1e-6 && abs < 1e21) {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	// JavaScript writes 1e+21 and 1e-7; Go writes 1e+21 and 1e-07.
	text := strconv.FormatFloat(f, 'e', -1, 64)
	if i := strings.IndexByte(text, 'e'); i >= 0 {
		mantissa, exponent := text[:i], text[i+1:]
		sign := ""
		if exponent[0] == '+' || exponent[0] == '-' {
			sign, exponent = string(exponent[0]), exponent[1:]
		}
		exponent = strings.TrimLeft(exponent, "0")
		if exponent == "" {
			exponent = "0"
		}
		text = mantissa + "e" + sign + exponent
	}
	return text
}

const hex = "0123456789abcdef"

// writeJSString escapes exactly as JSON.stringify does: the short escapes, the
// control characters as lowercase \u00xx, lone surrogates spelled out, and
// everything else -- including U+2028 and U+2029, which encoding/json escapes
// and JavaScript does not -- written as it stands.
func writeJSString(out *bytes.Buffer, s string) {
	out.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			switch {
			case r < 0x20:
				out.WriteString(`\u00`)
				out.WriteByte(hex[(r>>4)&0xf])
				out.WriteByte(hex[r&0xf])
			case r == utf8.RuneError:
				// Go hands back RuneError for an invalid byte; a lone surrogate
				// that survived a JSON decode arrives the same way. Either is
				// written as the replacement character, which is what a
				// round-trip through JSON.parse produces too.
				out.WriteRune(utf8.RuneError)
			case utf16.IsSurrogate(r):
				out.WriteString(`\u`)
				for shift := 12; shift >= 0; shift -= 4 {
					out.WriteByte(hex[(r>>uint(shift))&0xf])
				}
			default:
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}
