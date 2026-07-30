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
