<div align="center" width="100%">
    <img src="./frontend/public/icon.svg" width="128" alt="" />
</div>

# Dockge Fork with NTFY Notifications

This is a fork of [hamphh/dockge](https://github.com/hamphh/dockge), which is a fork of the excellent [Dockge](https://github.com/louislam/dockge) by [@louislam](https://github.com/louislam).

For general information about Dockge, please refer to the [original project](https://github.com/louislam/dockge).

## 🚀 Installation

### Quick Start with Docker Compose

1. Navigate to a directory where you want to store your Dockge setup (recommended: a faster drive):
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
- **UI Improvements** - Fullscreen YAML editor, collapsible terminal, button tooltips, copy/paste in terminal
- **Mobile Optimized** - Responsive layout with separate views for home and stack list
- **Container Controls** - Direct container management from the interface
- **Image Updates** - Notifications via skopeo integration with option to prune after updates

### Additional Features in This Fork

**NTFY Notification Support** 🔔

Get real-time push notifications for your Docker services and stacks via [NTFY](https://ntfy.sh).

- Monitor service and stack status changes (up/down, healthy/unhealthy)
- Custom NTFY server support with multiple authentication methods
- Granular event selection and smart rate limiting
- Configure at: **Settings → Notifications**

## 🔮 Planned Features

- Additional notification providers
- More monitoring and alerting options
- Further UI/UX improvements

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
