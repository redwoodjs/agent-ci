## Problem
The MCP client script can only set a Moment Graph namespace for query requests.

For ad-hoc demo namespaces, I also need to apply a namespace prefix so queries run against the same prefixed namespace used during indexing.

## Plan
- Add an env var for a Moment Graph namespace prefix.
- Include it in MCP query requests as `momentGraphNamespacePrefix`.
- Log whether the prefix is set.

## Progress
- Added `MOMENT_GRAPH_NAMESPACE_PREFIX` (and a `MACHINEN_MOMENT_GRAPH_NAMESPACE_PREFIX` fallback) to the MCP server script.
- Query requests now include `momentGraphNamespacePrefix` when set.
