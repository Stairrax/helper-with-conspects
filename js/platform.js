// Платформа: iPhone/iPad или остальное (в первую очередь Android). На iPhone другие подписи и инструкции,
// своя установка на экран «Домой» и свои ограничения браузера.

export const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Настоящий Android (не компьютер) — для оформления по умолчанию. */
export const ANDROID = /Android/i.test(navigator.userAgent);
/** «Android» / «iPhone» — для подписей вроде «голос Android». */
export const SYS = IOS ? 'iPhone' : 'Android';
