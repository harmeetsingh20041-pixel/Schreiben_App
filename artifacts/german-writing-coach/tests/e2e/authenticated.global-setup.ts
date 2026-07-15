import { validatePinnedHostedStagingManifest } from "./helpers/hosted-staging-safety";

export default async function authenticatedHostedStagingGlobalSetup() {
  await validatePinnedHostedStagingManifest();
}
