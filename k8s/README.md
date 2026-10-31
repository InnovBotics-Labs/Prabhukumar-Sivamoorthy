# Deploying to the home-lab Kubernetes cluster

The app is a Next.js server (SSR + API routes), so it runs as a container
behind an Ingress, not as static files. This folder holds the Kustomize
manifests; the image is built from the repo `Dockerfile` and pushed to Google
Artifact Registry by `.github/workflows/build-image.yml` on every push to
`Portfolio_AD`.

```
GitHub push (Portfolio_AD) ─► Actions: docker build + push ─► Artifact Registry
                                                                     │ pull (gar-pull secret)
                  kubectl apply -k k8s/base ─► Deployment ─► Service ─► Ingress (ingress-nginx)
                                                                                  ▲
                                            LAN: http://portfolio.home.lab:31409 ─┘
```

## This cluster

| Item | Value |
|------|-------|
| Distribution | kubeadm, Kubernetes v1.37, Calico CNI, containerd 2.2 |
| Control plane | `cp-cap` 10.0.0.131 (SSH user `avenger`) |
| Workers | `wk-bucky` 10.0.0.166, `wk-falcon` 10.0.0.216 |
| Ingress | ingress-nginx, IngressClass `nginx`, Service type **NodePort**: HTTP `31409`, HTTPS `31952` |
| Load balancer | none yet (MetalLB would give the ingress a real LAN IP and drop the port from URLs) |

Access is LAN-only for now: no public DNS, no TLS. All commands below are run
by you, from your laptop unless a step says otherwise.

## 0. One-time: kubectl from your laptop

The kubeconfig on the control plane is owned by `avenger`, so no sudo is needed.

```bash
scp avenger@10.0.0.131:.kube/config ~/.kube/homelab.yaml
grep server: ~/.kube/homelab.yaml   # expect https://10.0.0.131:6443; edit if it says a hostname or 127.0.0.1
KUBECONFIG=~/.kube/config:~/.kube/homelab.yaml kubectl config view --flatten > ~/.kube/config.new \
  && mv ~/.kube/config.new ~/.kube/config
kubectl config rename-context kubernetes-admin@kubernetes homelab
kubectl --context homelab get nodes   # expect cp-cap, wk-bucky, wk-falcon
```

Every command below passes `--context homelab` explicitly so a different default
context (minikube, docker-desktop) can never receive these manifests by accident.

## 1. GCP one-time setup (Artifact Registry)

1. Pick a project and region (e.g. `us-central1`). In the console or with gcloud:
   ```bash
   gcloud artifacts repositories create portfolio \
     --repository-format=docker --location=us-central1
   ```
2. Create a service account and give it write access (used by GitHub Actions)
   and read access (used by the cluster to pull). One account with the writer
   role covers both for a home lab:
   ```bash
   gcloud iam service-accounts create portfolio-ci
   SA=portfolio-ci@PROJECT_ID.iam.gserviceaccount.com
   gcloud projects add-iam-policy-binding PROJECT_ID --member="serviceAccount:$SA" --role=roles/artifactregistry.writer
   gcloud iam service-accounts keys create gar-key.json --iam-account="$SA"
   ```
   Store `gar-key.json` outside the project folder; never commit it.

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

The cluster is not GKE, so it needs credentials to pull from Artifact Registry.

```bash
kubectl --context homelab create namespace portfolio
kubectl --context homelab -n portfolio create secret docker-registry gar-pull \
  --docker-server=$REGION-docker.pkg.dev \
  --docker-username=_json_key \
  --docker-password="$(cat /path/to/gar-key.json)"
```

## 5. Deploy (Option A: from Artifact Registry)

1. Edit `k8s/base/kustomization.yaml`: set `images[0].newName` to your image
   path (`REGION-docker.pkg.dev/PROJECT_ID/REPO/portfolio`).
2. Edit `k8s/base/ingress.yaml` if you want a different LAN hostname than
   `portfolio.home.lab`.
3. Apply and watch the rollout:
   ```bash
   kubectl kustomize k8s/base                      # preview the rendered YAML
   kubectl --context homelab apply -k k8s/base
   kubectl --context homelab -n portfolio rollout status deploy/portfolio
   kubectl --context homelab -n portfolio get pods,svc,ingress
   ```
   If the pod sits in `ImagePullBackOff`, run
   `kubectl --context homelab -n portfolio describe pod -l app.kubernetes.io/name=portfolio`;
   it is almost always the pull secret or a typo in the image path.

## 5b. Deploy (Option B: no registry yet)

Use this to see the site on the cluster before GCP is set up. The image is built
on your laptop and imported straight into one worker's containerd; the
`k8s/overlays/local` overlay pins the pod to that worker (`wk-bucky`) and skips
the pull secret.

```bash
docker build -t portfolio:local .
docker save portfolio:local | ssh avenger@10.0.0.166 'sudo ctr -n k8s.io images import -'   # wk-bucky, sudo asks for a password
kubectl --context homelab apply -k k8s/overlays/local
kubectl --context homelab -n portfolio rollout status deploy/portfolio
```

If you cannot SSH to the worker directly, save to a file and hop through the
control plane:

```bash
docker save portfolio:local -o portfolio.tar
scp portfolio.tar avenger@10.0.0.131:
ssh avenger@10.0.0.131 'scp portfolio.tar avenger@10.0.0.166: && ssh avenger@10.0.0.166 "sudo ctr -n k8s.io images import portfolio.tar"'
```

To move to a different worker edit the `nodeSelector` in
`k8s/overlays/local/patch-local-image.yaml`; to run on any worker import the
image on all of them and delete the `nodeSelector`. Switching to Option A later
is just `kubectl --context homelab apply -k k8s/base`; it updates the same
Deployment in place.

## 6. Reach it on the LAN

ingress-nginx is a NodePort service, so HTTP is on port `31409` of **any** node.

1. Map the hostname to a node on your machine (`/etc/hosts` on macOS/Linux,
   `C:\Windows\System32\drivers\etc\hosts` on Windows), or add a record in your
   router / Pi-hole / local DNS:
   ```
   10.0.0.131  portfolio.home.lab
   ```
2. Open `http://portfolio.home.lab:31409/`.
3. Fallback check without touching DNS:
   ```bash
   curl -H "Host: portfolio.home.lab" http://10.0.0.131:31409/api/health
   ```

To lose the `:31409` later, install MetalLB and switch the
`ingress-nginx-controller` Service to `type: LoadBalancer`; the hosts entry then
points at the address MetalLB hands out.

## 7. Shipping updates

Every push to `Portfolio_AD` publishes a new `:latest` and `:<sha>` image.
Because the Deployment uses `imagePullPolicy: Always`, roll it out with:

```bash
kubectl --context homelab -n portfolio rollout restart deploy/portfolio
```

For exact, reproducible rollouts set `newTag` in `kustomization.yaml` to the
commit SHA and `kubectl --context homelab apply -k k8s/base` again. Roll back with
`kubectl --context homelab -n portfolio rollout undo deploy/portfolio`.

## 8. Later: going public

- **Expose publicly** either with a Cloudflare Tunnel (no router ports, hides
  your home IP) or by forwarding 80/443 to the ingress NodePorts and installing
  cert-manager with a Let's Encrypt ClusterIssuer. Then set the real hostname
  and uncomment the `tls:` block and annotation in `k8s/base/ingress.yaml`.
- **Automate rollouts** with Argo CD or Flux watching this folder, so the
  cluster pulls changes instead of GitHub needing access to it.

## Tear down

```bash
kubectl --context homelab delete -k k8s/base
```
