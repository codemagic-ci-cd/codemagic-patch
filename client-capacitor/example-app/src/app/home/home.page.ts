import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import type { DownloadProgress, RunningBundleUpdateMetadata } from '@codemagic/capacitor-patch';

import { PatchService } from '../services/patch.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnInit {
  private readonly patch = inject(PatchService);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  runningUpdate: RunningBundleUpdateMetadata | null = null;
  lastResult: string | null = null;
  progress: DownloadProgress | null = null;
  busy = false;

  ngOnInit(): void {
    void this.refreshRunningUpdate();
  }

  async onSync(): Promise<void> {
    this.busy = true;
    this.progress = null;
    try {
      const status = await this.patch.sync((progress) => {
        this.progress = progress;
        this.changeDetectorRef.detectChanges();
      });
      this.lastResult = `sync() -> ${status}`;
    } catch (error) {
      this.lastResult = `sync() threw: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.busy = false;
      this.progress = null;
      await this.refreshRunningUpdate();
    }
  }

  async onCheckForUpdate(): Promise<void> {
    this.busy = true;
    try {
      const result = await this.patch.checkForUpdate();
      this.lastResult = `checkForUpdate() -> ${result.action}`;
    } catch (error) {
      this.lastResult = `checkForUpdate() threw: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.busy = false;
      // Unlike onSync(), this path never calls refreshRunningUpdate() (checking for an
      // update doesn't change what's running), so nothing else would flush this
      // method's own busy/lastResult mutations — see refreshRunningUpdate()'s own
      // comment for why this is necessary at all.
      this.changeDetectorRef.detectChanges();
    }
  }

  private async refreshRunningUpdate(): Promise<void> {
    this.runningUpdate = await this.patch.runningUpdate();
    // Capacitor's native plugin bridge resolves its promises outside Angular's zone on
    // Android (a known Capacitor/Ionic interop gap — see capacitorjs.com/docs/guides/angular's
    // own NgZone.run() guidance). NgZone.run() alone was verified NOT sufficient here (a
    // real device test confirmed NgZone.isInAngularZone() still reads false even inside
    // its callback, likely the documented esbuild/zone.js duplicate-instance bundling
    // defect — angular/angular-cli#25972 — rather than anything under this app's
    // control), so this calls detectChanges() directly instead: it walks this
    // component's view and updates the DOM immediately, independent of whatever zone
    // the assignment above actually ran in.
    this.changeDetectorRef.detectChanges();
  }
}
