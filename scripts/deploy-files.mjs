// What makes up a deployable LicenseX. Shared by the zip bundle (`npm run bundle`) and the `deploy` branch (`npm run deploy-branch`).
export const INCLUDE_DIRS = ['server', 'web', 'docs'];
export const INCLUDE_FILES = ['package.json', 'README.md', 'DEPLOY.md', 'DESIGN_BRIEF.md', 'LICENSE', 'licensex.config.example.json', 'start.sh', 'start.bat', 'Dockerfile', '.dockerignore', 'render.yaml', 'Dockerfile.builder'];
