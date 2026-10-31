# Deploying to the home-lab Kubernetes cluster

The app is a Next.js server (SSR + API routes), so it runs as a container
behind an Ingress, not as static files. This folder holds the Kustomize
manifests; the image is built from the repo `Dockerfile` and pushed to GitHub
Container Registry (GHCR) by `.github/workflows/build-image.yml` on every push to
`Portfolio_AD`. The package is public, so the cluster pulls it with no credentials.

```
GitHub push (Portfolio_AD) ─► Actions: docker build + push ─► ghcr.io/innovbotics-labs/prabhukumar-sivamoorthy
                                                                     │ anonymous pull (public package)
                  kubectl apply -k k8s/base ─► Deployment ─► Service ─► Ingress (ingress-nginx)
                                                                                  ▲
                                            LAN: http://prabhukumar.sivamoorthy:31409 ─┘
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

## 1. GitHub: first image build

Nothing to pre-create. The workflow authenticates with the built-in
`GITHUB_TOKEN` and the package is created on the first push.

1. Org → Settings → Packages: package creation for public packages must be
   allowed (it is by default).
2. Push to `Portfolio_AD`, or run **Build and push image** from the Actions
   tab. The job summary lists the pushed tags
   (`ghcr.io/innovbotics-labs/prabhukumar-sivamoorthy:<sha>` and `:latest`).
3. **One time, after the first push:** repo → Packages →
   `prabhukumar-sivamoorthy` → Package settings → Danger Zone → Change
   visibility → **Public**. From now on the cluster pulls anonymously.

## 2. Only if you keep the package private

Skip this if the package is public. Otherwise create a classic personal access
token with the `read:packages` scope and give the cluster a pull secret:

```bash
kubectl --context homelab create namespace portfolio
kubectl --context homelab -n portfolio create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<github-username> --docker-password=<PAT>
```

Then uncomment the `imagePullSecrets` block in `k8s/base/deployment.yaml`.

## 3. Optional: build and push from your laptop

```bash
IMAGE=ghcr.io/innovbotics-labs/prabhukumar-sivamoorthy
docker build -t $IMAGE:latest .
echo <PAT-with-write:packages> | docker login ghcr.io -u <github-username> --password-stdin
docker push $IMAGE:latest
```

Quick local smoke test before pushing:

```bash
docker run --rm -p 3000:3000 $IMAGE:latest
curl -s localhost:3000/api/health      # {"status":"ok"}
```

## 4. Cluster: namespace

`kubectl apply -k k8s/base` creates the `portfolio` namespace itself, so there
is nothing to do here for the public-image path.

## 5. Deploy (Option A: from GHCR)

1. `k8s/base/kustomization.yaml` already points at the GHCR image; change
   `newTag` only if you want to pin a commit SHA.
2. Edit `k8s/base/ingress.yaml` if you want a different LAN hostname than
   `prabhukumar.sivamoorthy`.
3. Apply and watch the rollout:
   ```bash
   kubectl kustomize k8s/base                      # preview the rendered YAML
   kubectl --context homelab apply -k k8s/base
   kubectl --context homelab -n portfolio rollout status deploy/portfolio
   kubectl --context homelab -n portfolio get pods,svc,ingress
   ```
   If the pod sits in `ImagePullBackOff`, run
   `kubectl --context homelab -n portfolio describe pod -l app.kubernetes.io/name=portfolio`;
   it is almost always the package still being private (step 1.3).

## 5b. Deploy (Option B: no registry yet)

Use this to see the site on the cluster without pushing an image anywhere. The image is built
on your laptop and imported straight into one worker's containerd; the
`k8s/overlays/local` overlay pins the pod to that worker (`wk-bucky`).

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
   10.0.0.131  prabhukumar.sivamoorthy
   ```
2. Open `http://prabhukumar.sivamoorthy:31409/`.
3. Fallback check without touching DNS:
   ```bash
   curl -H "Host: prabhukumar.sivamoorthy" http://10.0.0.131:31409/api/health
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
