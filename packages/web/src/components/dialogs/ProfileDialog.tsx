import { useState } from 'react';
import { useStore } from '../../store';
import { Button, Dialog, Field, Input, Label, UserAvatar } from '../ui';
import { PictureUpload } from './PictureUpload';

const NAME_MAX = 40;

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [name, setName] = useState(settings.userName);
  const [avatar, setAvatar] = useState(settings.userAvatar);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    if (await updateSettings({ userName: name.trim(), userAvatar: avatar })) onClose();
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Your profile">
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void save(); }}>
        <div className="flex items-center gap-3">
          <UserAvatar name={name} avatar={avatar} size={64} />
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <PictureUpload onUploaded={setAvatar} />
            {avatar && <Button type="button" size="sm" variant="ghost" onClick={() => setAvatar('')}>Remove picture</Button>}
          </div>
        </div>
        <Field className="mt-4"><Label hint="Bots call you this">Name</Label><Input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
