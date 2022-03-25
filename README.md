# gha-artifact-uploader
Webservice that verifies GHA projects and allows you to upload them to remote storage providers.

### Steps to get started
- Create `config.yml`: `cp config.example.yml config.yml`
- Change the configuration as needed.
- Create a GitHub webhook pointing at your server with "Check runs", "Check suites", and "Pushes" events selected, content type "json", and the webhook secret as set in `config.yml`.
- Build and start Docker container: `docker-compose up`

You may take a look at https://github.com/overte-org/overte to see it in action on PR builds.