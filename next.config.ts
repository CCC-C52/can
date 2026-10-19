import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg ve aws-sdk gibi sunucu paketleri paketlenmeden Node üzerinden yüklenir.
  serverExternalPackages: ["pg", "@aws-sdk/client-s3"],
  poweredByHeader: false,
  // next dev geliştirme ajanları için AGENTS.md üretmesin (uygulamanın çalışma zamanı ajanlarıyla karışmasın)
  agentRules: false,
  experimental: {
    serverActions: { bodySizeLimit: "200mb" },
    proxyClientMaxBodySize: "200mb",
  },
};

export default nextConfig;
