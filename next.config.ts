import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg ve aws-sdk gibi sunucu paketleri paketlenmeden Node üzerinden yüklenir.
  serverExternalPackages: ["pg", "@aws-sdk/client-s3"],
  poweredByHeader: false,
  experimental: {
    serverActions: { bodySizeLimit: "200mb" },
    proxyClientMaxBodySize: "200mb",
  },
};

export default nextConfig;
