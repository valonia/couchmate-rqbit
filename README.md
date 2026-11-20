# rqbit – a Couchmate plugin

Watch a torrent together. Add a magnet link or a `.torrent` file in the admin panel, and its videos stream to
everyone in the room while they download, through [rqbit](https://github.com/ikatson/rqbit), a fast torrent client
with streaming built in.

- **Pick any episode.** A season pack shows as a list in the apps (S01E01, S01E02 …), and the episodes play in
  order. "Next episode" shows 10 s before the end.
- **Downloads ahead.** Only the episode being watched and the next few (4 by default) are downloaded, and whatever
  is being watched comes first, also when you skip ahead.
- **Starts straight away.** When a torrent is added, the first video starts downloading, so it is ready when you
  want to watch it.
- **Seeking works**, also in MKV files whose index sits at the end of the file (the plugin fetches it first).
- **Status page** in the admin panel: speed, peers (TCP and uTP), progress and time left for every episode,
  updated live.
- **Keeps the disk tidy.** Torrents nobody has watched for 15 minutes are paused once they are done, and the
  oldest downloads are removed when they take more space than you allow.

> Only add torrents you have the right to download and share. A torrent always uploads to others while it
> downloads.

**Requires:** rqbit running where the Couchmate server reaches its HTTP API.

## Run rqbit

Next to Couchmate in Docker, for example:

```yaml
services:
  rqbit:
    image: ikatson/rqbit:9.1.0
    container_name: rqbit
    restart: unless-stopped
    network_mode: host
    environment:
      RQBIT_HTTP_API_LISTEN_ADDR: 172.17.0.1:3030   # only on the Docker bridge, not on the LAN
      RQBIT_EXPERIMENTAL_UTP_LISTEN_ENABLE: "true"  # uTP finds many more peers
      RQBIT_LISTEN_PORT: "4240"
    volumes:
      - ./db:/home/rqbit/db
      - ./cache:/home/rqbit/cache
      - /path/to/a/big/disk:/home/rqbit/downloads
```

The Couchmate container then reaches it at `http://host.docker.internal:3030`. On Linux, give the Couchmate
service `extra_hosts: ["host.docker.internal:host-gateway"]`.

## Install

In the Couchmate admin panel, open **Plugins → Get plugins**, press **Install** on rqbit, switch it on and check
its settings. Open **rqbit** on the plugin's card to add torrents and see their status. The apps get an
**rqbit** entry in the menu as soon as there is a torrent.

## Settings

- **rqbit's HTTP API** – how the Couchmate server reaches rqbit, e.g. `http://host.docker.internal:3030`.
- **Episodes to download ahead of the one playing** – 4 by default. Raise it if downloads are slow.
- **Start downloading the first video when a torrent is added**
- **Disk space for downloads (GB)** – the oldest downloads are removed above this.

## Updates

The server checks this repository for new releases every 6 hours. Under **Plugins** you can update with one
click, or switch on **Update automatically** to have new versions installed by themselves. They wait until
nobody is watching.

To release a new version: raise `version` in `plugin.json`, commit, and publish a GitHub release tagged
`v<version>` (e.g. `v1.4.1`).
