# 2026-11-02 · DeepSeek · repair lane can restart Tailscale

RME1 (win-2) stopped answering on the tailnet while its GitHub runner kept talking to GitHub, so the mesh could not
reach it and the node could not be used. From the LocalSystem lane the machine reported `sshd: Running / Automatic`,
`port 22: LISTENING`, keys present — the sshd repair this workflow already does was not the problem. `tailscale ping`
timed out and the peer had fallen back to a relay.

So the missing capability was in the lane itself: it could start sshd and report, but not restart the Tailscale
service, which is the thing that had actually failed. This adds `restart-tailscale` as an action next to `start-sshd`.

What the next person needs: on a Windows node, "unreachable" and "sshd down" are different faults. Check the runner
(if it is online, the internet path is fine and Tailscale is the suspect), then `sshd`/port 22 from inside, and only
then touch sshd. A node whose runner is online and whose tailnet ping times out needs the *service* restarted.
