# Self-host mobile sync with Docker and Portainer

This stack runs Nibomo's backend and PostgreSQL on your server. The existing iOS and Android apps can sync text cards, decks, and reviews as guests over HTTPS. Each app installation gets its own guest workspace. Account sign-in, shared sync across devices, media uploads, AI, and the web and admin apps are outside this deployment's scope.

## Build the images

Use a Docker Standalone environment with Compose v2. Check out this branch on the Docker host and run the following from the repository root. Generate two different passwords with `openssl rand -hex 32` and save them in the copied file.

```bash
cp infra/self-host/.env.example infra/self-host/.env
```

Set `NIBOMO_DOMAIN` to a bare DNS name such as `flashcards.example.com`, and fill in `POSTGRES_PASSWORD` and `BACKEND_DB_PASSWORD`.

```bash
docker compose --env-file infra/self-host/.env \
  -f infra/self-host/compose.yml -f infra/self-host/compose.build.yml build
```

Build on the Docker endpoint managed by Portainer so the images are available there. To deploy prebuilt images from GitHub Container Registry, use the next section.

## Pull images from GitHub Container Registry

Set `NIBOMO_BACKEND_IMAGE` and `NIBOMO_MIGRATE_IMAGE` in the Portainer stack environment to the two full `ghcr.io` image references from the same build. Use `infra/self-host/compose.yml` as the stack file.

For private packages, add `ghcr.io` under **Registries → Add registry → Custom registry** in Portainer. Enable authentication and enter the GitHub username and a classic personal access token with `read:packages` for an account with access to both packages. Select that registry when deploying the stack. [Portainer custom registries](https://docs.portainer.io/admin/registries/add/custom) · [GitHub Container Registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

## Deploy in Portainer

1. Open **Stacks → Add stack → Web editor**, name the stack `nibomo`, and paste [compose.yml](../infra/self-host/compose.yml).
2. Add the values from your `infra/self-host/.env` under **Environment variables**. If the host ports are occupied, set `NIBOMO_API_PORT` and `NIBOMO_AUTH_PORT` to unused ports.
3. Deploy the stack using the local images or your registry tags. PostgreSQL uses the `pgdata` named volume. On a fresh deployment, `migrate` applies the schema and exits with status `0` before `backend` starts.

To deploy from Git on a local Docker endpoint, use `infra/self-host/compose.yml` as the Compose path and `infra/self-host/compose.build.yml` as an additional path. Remote endpoints use the prebuilt images and `compose.yml` alone. [Portainer Git stacks](https://docs.portainer.io/user/docker/stacks/add#option-3-git-repository) · [Portainer's remote build limitation](https://docs.portainer.io/faqs/known-issues/docker-compose-files-including-build-steps-fail)

You can also start the same stack from the repository root with Compose.

```bash
docker compose --env-file infra/self-host/.env -p nibomo \
  -f infra/self-host/compose.yml up -d --wait
```

When running the backend directly, `PORT` controls the API listener (default `8080`) and `GUEST_AUTH_PORT` controls the guest auth listener (default `8081`). Choose distinct ports. With the supplied Compose stack, change the published host ports using the stack variables above.

## Configure Nginx Proxy Manager

Choose how Nginx Proxy Manager (NPM) reaches the stack.

- **LAN IP and port.** Set `NIBOMO_BIND_IP` in the Portainer stack to the Docker host's LAN IP, for example `192.168.1.50`, and deploy the stack. Use that IP with host ports `8080` and `8081` (or your configured `NIBOMO_API_PORT` and `NIBOMO_AUTH_PORT`). Keep those ports on the LAN and restrict access to the proxy.
- **Same Docker host.** Keep `NIBOMO_BIND_IP=127.0.0.1` and connect the NPM container with `docker network connect nibomo_ingress <npm-container>`. Use `nibomo-backend` and container ports `8080` and `8081`. To keep the connection when NPM is recreated, declare `nibomo_ingress` as an external network in the NPM stack and attach only its proxy service. [NPM Docker network guide](https://nginxproxymanager.com/advanced-config/#best-practice-use-a-docker-network)

Point both DNS names at NPM. The base domain entered in the app is used to derive those two names. In **Hosts → Proxy Hosts**, add one proxy host per row. Use the `http` scheme for forwarding. On the **SSL** tab, select or request a certificate trusted by the phone and enable **Force SSL**.

| Domain name in NPM | Example LAN upstream | Same-host Docker upstream | HTTPS check |
| --- | --- | --- | --- |
| `api.flashcards.example.com` | `192.168.1.50:8080` | `nibomo-backend:8080` | `GET /v1/health` |
| `auth.flashcards.example.com` | `192.168.1.50:8081` | `nibomo-backend:8081` | `GET /health` |

Use the default path forwarding so `/v1` reaches the backend. Restrict both proxy hosts to your LAN or VPN. If you use an NPM access list, use IP rules without HTTP Basic Auth so the app can send its `Authorization: Guest` header. Anyone who can reach the API can create a guest workspace. [NPM access list behavior](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/backend/templates/_access.conf)

## Connect the mobile app

Check both HTTPS URLs from the phone's network. The API health response should contain `service: "flashcards-open-source-app-backend"` and `cloudContractVersion: 1`. The auth health response should contain `ok: true` and `mode: "guest"`.

Before switching servers, resetting the app, or reinstalling, protect the cards you want to keep. On Android, both package exports require a linked account. For a guest, sync to the current server and verify the cards there before making a database backup. Copy any important unsynced questions and answers somewhere outside the app while they are still accessible. Switching servers clears the local Android workspace and guest credential. Losing that credential can prevent a new installation from accessing the old workspace, even after a database restore.

In the Nibomo app, open **Settings** and find **Server** under **Advanced**. Enter `https://flashcards.example.com` as the custom server. Wait for both HTTPS checks to pass. Android builds from this branch ask for confirmation before a switch. Older Android builds can clear local data as soon as you apply or reset the server, including when you reselect the current address. Continue using the app as a guest, then create and review a text card. Reopen the app and confirm the account status reports a successful sync. To check offline replay, edit the card offline, reconnect to your private network, then confirm sync succeeds again.

## Back up and update

Back up the PostgreSQL data and keep the stack settings and passwords somewhere private. From the repository root on the Docker host, run:

```bash
docker compose --env-file infra/self-host/.env -p nibomo -f infra/self-host/compose.yml \
  exec -T postgres pg_dump -U flashcards_owner -Fc flashcards > nibomo.dump
```

Copy the dump off the host and test the restore. For a readable copy of synced card text, the server operator can also write a CSV from PostgreSQL. This file includes active cards from every workspace on the server, identified by workspace ID. Keep it private.

```bash
docker compose --env-file infra/self-host/.env -p nibomo -f infra/self-host/compose.yml \
  exec -T postgres psql -X --csv -v ON_ERROR_STOP=1 -U flashcards_owner -d flashcards \
  -c 'SELECT workspace_id, card_id, front_text, back_text FROM content.cards WHERE deleted_at IS NULL ORDER BY workspace_id, card_id' > synced-cards.csv
```

Before updating, take a fresh backup and stop the stack. Rebuild both images or set both registry tags to the new revision, then redeploy using the same project name and volume. Check that the migration job succeeded and both HTTPS health endpoints respond before syncing again.
