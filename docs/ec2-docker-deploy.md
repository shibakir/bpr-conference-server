# EC2 Docker deploy

This repository deploys the server from `main` with GitHub Actions:

1. Run `npm run check`.
2. Build the Docker image.
3. Push the image to GitHub Container Registry.
4. SSH into the EC2 instance and replace the Docker container.

The deploy script keeps the previous container until the new one passes the healthcheck. If the new container fails, it removes the failed container and starts the previous one again.

## GitHub configuration

Add these repository secrets in `Settings -> Secrets and variables -> Actions -> Secrets`:

```text
EC2_HOST=3.249.105.232
EC2_USER=ubuntu
EC2_SSH_KEY=<private deploy key contents>
```

Use `ec2-user` instead of `ubuntu` if the instance is Amazon Linux.

Optional repository variables in `Settings -> Secrets and variables -> Actions -> Variables`:

```text
EC2_SSH_PORT=22
EC2_CONTAINER_NAME=bpr-conference-server
EC2_HOST_PORT=3001
EC2_BIND_ADDRESS=0.0.0.0
EC2_HEALTHCHECK_PATH=/api/auth/status
EC2_ENV_FILE=/opt/bpr-conference-server/.env
```

If the API is behind nginx or another reverse proxy on the same instance, set `EC2_BIND_ADDRESS=127.0.0.1`.

## Create a deploy key

Create a dedicated key on your local machine:

```bash
mkdir -p ~/.ssh
ssh-keygen -t rsa -b 4096 -m PEM -f ~/.ssh/bpr-conference-deploy.pem -C "bpr-conference-deploy"
chmod 400 ~/.ssh/bpr-conference-deploy.pem
```

Put the private key content into the `EC2_SSH_KEY` GitHub secret:

```bash
cat ~/.ssh/bpr-conference-deploy.pem
```

Add the public key to the EC2 deploy user's `~/.ssh/authorized_keys`:

```bash
cat ~/.ssh/bpr-conference-deploy.pem.pub
```

Do not commit either key.

## Prepare the EC2 instance

Create the app directory and env file on the instance:

```bash
sudo mkdir -p /opt/bpr-conference-server
sudo nano /opt/bpr-conference-server/.env
```

The env file should contain the production values, for example:

```env
API_PORT=3001
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_URL=...
GEMINI_API_KEY=...
BROADCAST_PASSWORD=...
NEXT_PUBLIC_ATTENDEE_ORIGIN=...
```

Make sure Docker is installed and the deploy user can run Docker either directly or with passwordless sudo:

```bash
docker info
```

If Docker requires sudo, the deploy script will try `sudo -n docker`. That means sudo must not prompt for a password.

## First deploy

After secrets and variables are configured, push to `main` or run the workflow manually from GitHub Actions.

The deployed container is named `bpr-conference-server` by default. If the current production container already uses another name, either set `EC2_CONTAINER_NAME` to that name before the first deploy or stop the old container manually.

Find the current container name on the instance:

```bash
docker ps
```

Check the deployed container:

```bash
docker ps --filter name=bpr-conference-server
docker logs --tail 100 bpr-conference-server
```

Replace `bpr-conference-server` in these commands if `EC2_CONTAINER_NAME` is different.
