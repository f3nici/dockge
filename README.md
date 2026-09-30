<div align="center" width="100%">
    <img src="./frontend/public/icon.svg" width="128" alt="" />
</div>

# Dockge Fork

This is a fork of [hamphh/dockge](https://github.com/hamphh/dockge), which is a fork of the excellent [louislam/dockge](https://github.com/louislam/dockge).

For general information about Dockge, please refer to the [original project](https://github.com/louislam/dockge).

## 🚀 Installation

### Quick Start with Docker Compose

1. Navigate to a directory where you want to store your Dockge setup (recommened to use a fast drive):
```bash
cd /path/to/your/docker/setup
```

2. Download the compose file:
```bash
curl -o compose.yaml https://raw.githubusercontent.com/f3nici/dockge/master/compose.yaml
```

3. Start Dockge:
```bash
docker compose up -d
```

4. Access Dockge at `http://localhost:5001`

⚠️ **Important:** Make a backup of your Dockge data folder before migrating from the original or hamphh's version, as this image modifies the database.

### Supported Platforms

Currently, the image is built for:
- **linux/amd64**
- **linux/arm/v7**
- **linux/arm64**

## ✨ Features

This fork includes all features from [hamphh/dockge](https://github.com/hamphh/dockge) plus additional enhancements.

### From hamphh/dockge

- **Enhanced Dashboard** - Agent renaming, agent maintenance, and stack list filtering
- **Agent Maintenance** - List and prune containers, images, networks, and volumes
- **Update Management** - Enhanced update notifications with changelogs and skip options
- **Service Controls** - Disable update checks, add changelog links, ignore service status
- **Health Monitoring** - Unhealthy status display (updated within 5 minutes)
- **UI Improvements** - Fullscreen YAML editor, collapsible terminal, button tooltips
- **Mobile Optimized** - Responsive layout with separate views for home and stack list
- **Container Controls** - Direct container management from the interface
- **Image Updates** - Notifications via skopeo integration with option to prune after updates

### From f3nici/dockge (this fork)

- **Terminal Copy/Paste** - Copy and paste support in the terminal interface
- **[NTFY](https://ntfy.sh) Notification Support** - Monitor service and stack status changes
- **Tagging with folders** - Add tags to stacks to place them into folders
- **Bug Fixes** - Fixes for any issues i've encountered as i've used dockge
- **UI/UX Improvements** - Adjusted about page & updated title
- **Dockge Update Checker** - Now checks for updates to dockge
- **Clear Console Button** - Button to clear the console
- **Generate Password Button** - Next to .env, creates a 32 random string to use for SECRET varibles or passwords.
- **Agent Console** - Open a console directly on any online agent from the dashboard
- **Full-Width Log Option** - Appearance setting to show the stack log full width for easier scanning
- **Scheduled Auto Update** - Pull new images and recreate stacks on a configurable cron schedule, with an "Update now" button. Each stack picks *Always update*, *Never update*, or *Inherit from settings* on its own page, saved as `x-dockge.auto-update` in its compose file. Stacks that don't pick follow the global default in Settings, which is "Do nothing" out of the box. One schedule covers every stack you can see: each run also asks every agent to update its own stacks with the same settings.
- **Registry Logins** - Sign in to Docker Hub (or any other registry) under *Settings → Registries*, so update checks and pulls no longer run anonymously. Docker Hub allows about 100 anonymous pulls per 6 hours per IP address and every image update check spends one, which a busy host burns through quickly; signing in roughly doubles the allowance and counts it against your account instead. The page also shows how many pulls are left in the current window. Credentials are written to a docker `config.json` in the data directory, which is passed to skopeo (`--authfile`) and to the docker CLI (`DOCKER_CONFIG`). Each endpoint has its own logins, so add them on your agents too.
- **Compose Override Editing** - Edit `compose.override.yaml` from the stack page, alongside the main compose file. Whichever of the names Docker Compose accepts a stack already uses is kept, and clearing the editor deletes the file rather than leaving an empty one behind. Agents that predate this simply do not offer the editor.
- **Stack Notes** - A free-text notes box on each stack, stored as `x-dockge.notes` in the compose file so the notes travel with the stack through a backup or a move to another host.
- **Log Filtering** - A filter box on the stack and service logs that narrows the output to matching lines. Lines that scrolled past before you started typing are still searched, and clearing the box puts the whole log back.
- **Unset Variable Warnings** - `${VARIABLES}` the `.env` does not define are underlined in the compose editor. Docker Compose silently replaces them with an empty string, so a typo in a name would otherwise blank an image tag or a port without a word. Variables with a default are left alone.
- **Default Compose Template** - Set a starting compose file under *Settings → General*, used in place of the built-in example whenever you add a stack.
- **Configurable Base Path** - Serve Dockge under a subpath of a domain, such as `https://example.com/dockge/`, with `DOCKGE_BASE_PATH=/dockge` (or `--base-path`). Static assets, the socket connection and the routes in the address bar all move under the prefix, and the bare domain redirects to it.
- **Shared Compose Blocks** - Services that take their configuration from a shared block with `<<: *common` now report the image they inherit instead of none.
- **Included Services** - A stack whose compose file pulls its services in with `include:` shows the containers Docker is running for it, instead of appearing empty.
- **Compose File Fidelity** - Values written with a leading zero, such as `mode: 0755`, keep that form when Dockge writes a compose file back. Docker Compose reads them as octal, so rewriting them as `755` changed what they meant.

## 📖 Usage

For general information about using Dockge, please refer to the [original project documentation](https://github.com/louislam/dockge).

## Multi-Server Setup

If you're using Dockge with multiple agents, update the image to `f3nici/dockge:latest` on **all endpoints**.

## 📋 Release Notes

For detailed information about changes and updates, see the [releases page](https://github.com/f3nici/dockge/releases).
