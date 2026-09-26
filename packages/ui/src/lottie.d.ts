// The ES module builds of lottie-web 5.13 ship without declarations; each exports the
// player of lottie-web's own index.d.ts as its default.
declare module "lottie-web/build/player/esm/lottie_light.min.js" {
  import type { LottiePlayer } from "lottie-web";
  const lottie: LottiePlayer;
  export default lottie;
}

declare module "lottie-web/build/player/esm/lottie_light_canvas.min.js" {
  import type { LottiePlayer } from "lottie-web";
  const lottie: LottiePlayer;
  export default lottie;
}
