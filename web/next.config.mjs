/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  // Proxy hook-server SSE endpoint so the browser can connect without CORS issues
  async rewrites() {
    const hookServerPort = process.env.HOOK_SERVER_PORT || '7842'
    return [
      {
        source: '/hook-events',
        destination: `http://127.0.0.1:${hookServerPort}/hook-events`,
      },
    ]
  },
}

export default nextConfig
