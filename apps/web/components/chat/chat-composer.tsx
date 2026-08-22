'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A plain grow-to-fit textarea plus a send button. `@shadcn/input-group` was
 * evaluated (`bunx shadcn search @shadcn -q input`) and passed over: its
 * markup assumes shadcn's own `Input`/`Textarea` plus a large set of
 * `dark:`/ring/opacity utilities tied to that project's token names, none of
 * which exist in ours (`docs/web-design.md` §4 tokens are `--sc-*`, not
 * `--ring`/`--input`). Re-skinning it would mean rewriting nearly every
 * class, for a control that is a single textarea and a single button. This
 * hand-rolled composer follows the same shape as `FieldControl`
 * (`components/ui/field.tsx`) instead.
 */
export function ChatComposer({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !disabled;

  function grow(element: HTMLTextAreaElement): void {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }

  function submit(): void {
    const text = value.trim();
    if (text.length === 0 || disabled) return;
    onSubmit(text);
    setValue('');
    const element = textareaRef.current;
    if (element !== null) {
      element.style.height = 'auto';
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 border-t border-line bg-ground-1 p-3 sm:p-4">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          aria-label={t('chat.composerLabel')}
          placeholder={t('chat.composerPlaceholder')}
          value={value}
          disabled={disabled}
          rows={1}
          onChange={(event) => {
            setValue(event.target.value);
            grow(event.target);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            'max-h-40 min-h-[42px] w-full min-w-0 resize-none rounded-input border border-line bg-ground-2 px-3.5 py-2.5 text-sm text-ink',
            'placeholder:text-ink-3',
            'transition-colors duration-150 hover:border-line-strong',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            'disabled:cursor-not-allowed disabled:opacity-45',
          )}
        />
        <Button type="submit" variant="primary" disabled={!canSend}>
          {t('chat.send')}
        </Button>
      </div>
      <p className="px-1 text-xs text-ink-3">{t('chat.composerHint')}</p>
    </form>
  );
}
