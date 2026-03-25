package relayauth

import "strings"

var manageImplies = map[string]struct{}{
	"read":   {},
	"write":  {},
	"create": {},
	"delete": {},
}

type parsedScope struct {
	Plane    string
	Resource string
	Action   string
	Path     string
}

// MatchScope returns true when a granted scope covers the required scope.
func MatchScope(required, granted string) bool {
	req, ok := parseScope(required)
	if !ok {
		return false
	}
	gr, ok := parseScope(granted)
	if !ok {
		return false
	}

	if gr.Plane != "*" && gr.Plane != req.Plane {
		return false
	}
	if gr.Resource != "*" && gr.Resource != req.Resource {
		return false
	}
	if !matchAction(req.Action, gr.Action) {
		return false
	}
	return matchPath(req, gr)
}

// HasScope returns true when any granted scope matches the required scope.
func HasScope(granted []string, required string) bool {
	for _, scope := range granted {
		if MatchScope(required, scope) {
			return true
		}
	}
	return false
}

func parseScope(raw string) (parsedScope, bool) {
	parts := strings.Split(raw, ":")
	if len(parts) != 3 && len(parts) != 4 {
		return parsedScope{}, false
	}
	for _, part := range parts {
		if part == "" {
			return parsedScope{}, false
		}
	}

	path := "*"
	if len(parts) == 4 {
		path = parts[3]
	}

	return parsedScope{
		Plane:    parts[0],
		Resource: parts[1],
		Action:   parts[2],
		Path:     path,
	}, true
}

func matchAction(required, granted string) bool {
	if granted == "*" || granted == required {
		return true
	}
	if granted == "manage" {
		_, ok := manageImplies[required]
		return ok
	}
	return false
}

func matchPath(required, granted parsedScope) bool {
	if granted.Path == "*" || granted.Path == required.Path {
		return true
	}

	if required.Plane != "relayfile" || required.Resource != "fs" {
		return false
	}

	if !strings.HasSuffix(granted.Path, "/*") {
		return false
	}

	prefix := strings.TrimSuffix(granted.Path, "*")
	return strings.HasPrefix(required.Path, prefix)
}
