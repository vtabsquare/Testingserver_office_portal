// pages/faceAuthReverify.js
//
// Landing page for the deep link the Monitoring Tool's native OS notification
// opens (e.g. https://officehub360.vtabsquare.com/#/faceauth-reverify). Once
// loaded, it immediately triggers the same re-verification redirect the
// in-app FaceAuth alert banner's "Verify Now" button uses - this route's only
// job is to give the desktop notification something to open in the browser.
import { getPageContentHTML } from '../utils.js';
import { redirectToFaceAuth } from '../features/faceAuthAlert.js';

export const renderFaceAuthReverifyPage = async () => {
  const content = `
    <div class="card" style="padding: 60px 40px; text-align: center;">
      <i class="fa-solid fa-camera" style="font-size: 48px; color: var(--primary-color, #4f46e5); margin-bottom: 16px;"></i>
      <h2>Redirecting to Face Verification...</h2>
      <p style="color: var(--text-secondary);">Please wait, we're taking you to face re-verification.</p>
    </div>
  `;
  document.getElementById('app-content').innerHTML = getPageContentHTML('Face Verification', content);

  try {
    await redirectToFaceAuth();
  } catch (err) {
    console.error('[FACEAUTH-REVERIFY] Failed to start re-verification redirect:', err);
  }
};
