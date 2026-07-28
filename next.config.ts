import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // A stray package-lock.json in the home directory makes Next infer the
  // workspace root as C:\Users\araga, which pulls the wrong tree into the
  // output file trace and produces confusing bundles on deploy.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
