# Deploying to the home-lab Kubernetes cluster

The app is a Next.js server (SSR + API routes), so it runs as a container
behind an Ingress, not as static files. This folder holds the Kustomize
manifests; the image is built from the repo `Dockerfile` and pushed to Google
Artifact Registry by `.github/workflows/build-image.yml`.

Target setup: ingress-nginx, LAN access only (no public DNS or TLS yet),
deploy branch `Portfolio_AD`. Render (`render.yaml`) stays live until the
cluster is proven.

```
GitHub push (Portfolio_AD) ─► Actions: docker build + push ─► Artifact Registry
                                                                     │ pull (gar-pull secret)
                           kubectl apply -k k8s/base ─► Deployment ─► Service ─► Ingress (nginx)
                                                                                      ▲
                                                             LAN: portfolio.home.lab ─┘
```

## 1. GCP one-time setup (Artifact Registry)

1. Pick a project and region (e.g. `us-central1`). In the console or with gcloud:
   ```bash
   gcloud artifacts repositories create portfolio \
     --repository-format=docker --location=us-central1
   ```
2. Create a service account and give it write access (used by GitHub Actions)
   and read access (used by the cluster to pull). One account with both roles
   is fine for a home lab:
   ```bash
   gcloud iam service-accounts create portfolio-ci
   SA=portfolio-ci@PROJECT_ID.iam.gserviceaccount.com
   gcloud projects add-iam-policy-binding PROJECT_ID --member="serviceAccount:$SA" --role=roles/artifactregistry.writer
   gcloud iam service-accounts keys create gar-key.json --iam-account="$SA"
   ```
   Keep `gar-key.json` out of the repo (`.gitignore` already ignores nothing by
   that name, so store it outside the project folder).

## 2. GitHub: configure and run the image build

Repository → Settings → Secrets and variables → Actions:

| Kind     | Name              | Value                                  |
|----------|-------------------|----------------------------------------|
| Variable | `GCP_PROJECT_ID`  | your GCP project id                    |
| Variable | `GAR_REGION`      | e.g. `us-central1`                     |
| Variable | `GAR_REPOSITORY`  | `portfolio` (the repo from step 1)     |
| Secret   | `GCP_SA_KEY`      | full contents of `gar-key.json`        |

Push to `Portfolio_AD` or run **Build and push image** from the Actions tab.
The job summary prints the pushed tags. Confirm the image shows up under
Artifact Registry in the GCP console.

## 3. Optional: build and push from your laptop (no gcloud needed)

```bash
REGION=us-central1; PROJECT_ID=...; REPO=portfolio
IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/portfolio

docker build -t $IMAGE:latest .
cat /path/to/gar-key.json | docker login -u _json_key --password-stdin $REGION-docker.pkg.dev
docker push $IMAGE:latest
```

Quick local smoke test before pushing:

```bash
docker run --rm -p 3000:3000 $IMAGE:latest
curl -s localhost:3000/api/health      # {"status":"ok"}
```

## 4. Cluster: namespace and image pull secret

Your cluster is not GKE, so it needs credentials to pull from Artifact Registry.

```bash
kubectl create namespace portfolio
kubectl -n portfolio create secret docker-registry gar-pull \
  --docker-server=$REGION-docker.pkg.dev \
  --docker-username=_json_key \
  --docker-password="$(cat /path/to/gar-key.json)"
```

## 5. Deploy

1. Edit `k8s/base/kustomization.yaml`: set `images[0].newName` to your image
   path (`REGION-docker.pkg.dev/PROJECT_ID/REPO/portfolio`).
2. Edit `k8s/base/ingress.yaml` if you want a different LAN hostname than
   `portfolio.home.lab`.
3. Apply and watch the rollout:
   ```bash
   kubectl kustomize k8s/base            # preview the rendered YAML
   kubectl apply -k k8s/base
   kubectl -n portfolio rollout status deploy/portfolio
   kubectl -n portfolio get pods,svc,ingress
   ```
   If the pod sits in `ImagePullBackOff`, check `kubectl -n portfolio describe pod ...`;
   it is almost always the pull secret or a typo in the image path.

## 6. Reach it on the LAN

1. Find the address ingress-nginx is listening on:
   ```bash
   kubectl -n ingress-nginx get svc
   ```
   Use the `EXTERNAL-IP` if the service is a LoadBalancer (MetalLB etc.), or
   `<any node IP>:<NodePort for 80>` if it is a NodePort.
2. Map the hostname to it on your machine (`/etc/hosts` on macOS/Linux,
   `C:\Windows\System32\drivers\etc\hosts` on Windows), or add a record in your
   router / Pi-hole / local DNS:
   ```
   192.168.1.50  portfolio.home.lab
   ```
3. Open `http://portfolio.home.lab/`. Fallback check without DNS:
   ```bash
   curl -H "Host: portfolio.home.lab" http://<ingress-ip>/api/health
   ```

## 7. Shipping updates

Every push to `Portfolio_AD` publishes a new `:latest` and `:<sha>` image.
Because the Deployment uses `imagePullPolicy: Always`, roll it out with:

```bash
kubectl -n portfolio rollout restart deploy/portfolio
```

For exact, reproducible rollouts set `newTag` in `kustomization.yaml` to the
commit SHA and `kubectl apply -k k8s/base` again. Roll back with
`kubectl -n portfolio rollout undo deploy/portfolio`.

## 8. Later: going public and leaving Render

- **Expose publicly** either with a Cloudflare Tunnel (no router ports, hides
  your home IP) or by forwarding 80/443 to the ingress and installing
  cert-manager with a Let's Encrypt ClusterIssuer. Then set the real hostname
  and uncomment the `tls:` block and annotation in `ingress.yaml`.
- **Automate rollouts** with Argo CD or Flux watching this folder, so the
  cluster pulls changes instead of GitHub needing access to it.
- **Decommission Render**: delete the service in the Render dashboard, remove
  `render.yaml`, and update the Deploy note in `CLAUDE.md`.

## Tear down

```bash
kubectl delete -k k8s/base
```
