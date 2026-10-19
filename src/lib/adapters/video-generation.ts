// AI video üretim adaptörü arayüzü. Bu sürümde somut sağlayıcı YOK.
// Sağlayıcı eklendiğinde: VideoGenerator uygulayın, connections.ts içinde "video_generation" durumunu bağlayın
// ve executor'daki render adımı bu arayüzü kullanacaktır. O zamana kadar ilgili görevler "Bağlantı bekliyor" kalır.

export interface VideoGenerator {
  readonly service: string;
  estimateCostUsd(durationS: number): number | null;
  generate(args: { prompt: string; durationS: number; format: string }): Promise<Buffer>;
}

export function getVideoGenerator(): VideoGenerator | null {
  return null;
}
