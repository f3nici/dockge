<div align="center" width="100%">
    <img src="./frontend/public/icon.svg" width="128" alt="" />
</div>

# Dockge Fork with NTFY Notifications

This is a fork of the excellent [Dockge](https://github.com/louislam/dockge) by [@louislam](https://github.com/louislam).
Since I was missing some features and the project doesn't seem to be actively maintained at the moment, I have implemented these features here in my fork.

For general information about Dockge, please refer to the [original project](https://github.com/louislam/dockge).

## 🚀 Installation

### Quick Start with Docker Compose

1. Create a directory for Dockge:
```bash
mkdir -p /opt/dockge /opt/stacks
cd /opt/dockge
```

2. Create a `compose.yaml` file:
```yaml
services:
  dockge:
    image: f3nici/dockge:latest
    container_name: dockge
    restart: unless-stopped
    ports:
      - 5001:5001
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
      - /opt/stacks:/opt/stacks
    environment:
      - DOCKGE_STACKS_DIR=/opt/stacks
      # - DOCKGE_ENABLE_CONSOLE=true
```

3. Start Dockge:
```bash
docker compose up -d
```

4. Access Dockge at `http://localhost:5001`

⚠️ **Important:**
- Make a backup of your Dockge data folder before migrating from the original version, as this image modifies the database.
- The stacks directory path must be the same on both host and container (e.g., `/opt/stacks:/opt/stacks`)

### Supported Platforms

Currently, the image is built for:
- **linux/amd64**
- **linux/arm/v7**
- **linux/arm64**

Additional platforms can be added if needed.

## ✨ Differences from Original Dockge

This fork adds the following features not available in the original Dockge:

### 1. **NTFY Notification Support** 🔔

Get real-time push notifications for your Docker services and stacks via [NTFY](https://ntfy.sh).

**Supported Events:**
- 🔴 **Service Down** - When a service stops or exits
- 🟢 **Service Up** - When a service starts running
- 🟡 **Service Unhealthy** - When a health check fails
- ✅ **Service Healthy** - When a service becomes healthy again
- 🛑 **Stack Exited** - When an entire stack stops
- ▶️ **Stack Running** - When an entire stack starts

**Features:**
- Custom NTFY server support (defaults to https://ntfy.sh)
- Multiple authentication methods:
  - Public (no auth)
  - Access Token (Bearer token)
  - Basic Auth (username/password)
- Granular event selection - choose which events trigger notifications
- Smart rate limiting to prevent notification spam (1-minute cooldown per event)
- Test notification button to validate configuration
- Detailed messages with priority levels and emoji tags

**Configuration:**
Access notification settings in Dockge at: **Settings → Notifications**

### 2. **IPv4 Network Family Option**

Forces IPv4 for NTFY server connections, useful in environments with IPv6 issues or IPv4-only networks.

## 📖 Usage

For general information about using Dockge, please refer to the [original project documentation](https://github.com/louislam/dockge).

### Migrating from Original Dockge

To migrate from the original Dockge to this fork:

1. **Backup your data:**
   ```bash
   cp -r /opt/dockge/data /opt/dockge/data.backup
   ```

2. **Update your compose.yaml:**
   - Replace `louislam/dockge:1` with `f3nici/dockge:latest`
   - Update to match the compose file format above

3. **Restart the container:**
   ```bash
   docker compose down
   docker compose up -d
   ```

4. The database will be automatically migrated on first start

### Multi-Server Setup

If you're using Dockge with multiple agents, update the image to `f3nici/dockge:latest` on **all endpoints**.

## 📋 Release Notes

For detailed information about changes and updates, see the [releases page](https://github.com/f3nici/dockge/releases).

## 📄 License

Same as the original Dockge project.
