# Third-party notices

## Bubblewrap 0.11.2

Linux builds of NexusCode include an unmodified `bubblewrap` executable as
`nexus-bwrap`. NexusCode uses it to establish user, mount, PID, IPC, UTS, and
network namespaces before its own seccomp stage is installed.

The corresponding source is vendored under
`native/sandbox/vendor/bubblewrap/`. It was taken from the vendored
Bubblewrap 0.11.2 tree in the OpenAI Codex source snapshot used by this
repository. Bubblewrap is distributed under the GNU Library General Public
License version 2; the complete license text is included as
`native/sandbox/vendor/bubblewrap/COPYING` and is copied beside every packaged
Linux binary as `COPYING.bubblewrap`.

Upstream project: <https://github.com/containers/bubblewrap>

## OpenAI Codex Windows sandbox

The NexusCode Windows sandbox security architecture and selected low-level
process, token, ACL, desktop, job-object, user-isolation, and firewall patterns
are adapted from the Apache License 2.0 `windows-sandbox-rs` implementation in
OpenAI Codex, source revision
`61a44880a85d2fd0d8770908dea5733495e571c8`.

NexusCode uses its own Go implementation, protocol, identities, state layout,
packaging, diagnostics, and product integration. It does not bundle or invoke a
Codex executable.

Upstream project: <https://github.com/openai/codex>

License: Apache License 2.0,
<https://www.apache.org/licenses/LICENSE-2.0>
