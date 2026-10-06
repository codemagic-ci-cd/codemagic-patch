import { Component, inject } from '@angular/core';

import { PatchService } from './services/patch.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  constructor() {
    // Confirms whichever package this launch booted into — see
    // PatchService.notifyAppReady's own doc comment for why this is separate from
    // the SYNC()/CHECKFORUPDATE() buttons on the home page. Real apps call this (or
    // sync(), which calls it internally) unconditionally on every cold start; a demo
    // that only calls it from a manual button risks exactly what real testing against
    // a live Patch server surfaced — an installed update staying "pending"
    // forever and being rolled back on the next launch, never confirmed.
    const patch = inject(PatchService);
    void patch.notifyAppReady();
  }
}
