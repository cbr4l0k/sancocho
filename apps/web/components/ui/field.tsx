'use client';

import { Field as FieldPrimitive } from '@base-ui/react/field';
import { useTranslations } from 'next-intl';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The form field.
 *
 * Conventions this primitive enforces, so no screen re-decides them:
 *
 * - The label sits **above** the control, left-aligned. Side-by-side labels need
 *   a fixed label column, and a fixed column is the first thing Spanish breaks.
 * - **Required** is marked, optional is not. Service Kind fields are optional by
 *   default in the backend, so `required` is the exception worth flagging: an
 *   accent bullet plus a screen-reader-only word, never colour alone.
 * - Validation messages appear **below the control, inline**, and the control
 *   gets `aria-invalid`. Base UI wires `aria-describedby` for the description
 *   and the error; that is the whole reason this is not a bare `<label>`.
 *
 * Base UI's `Field.Root` also owns touched/dirty/valid state, so a screen never
 * hand-rolls "show the error only after blur".
 */
export function Field({ className, ...props }: FieldPrimitive.Root.Props) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
      {...props}
    />
  );
}

export type FieldLabelProps = FieldPrimitive.Label.Props & {
  /** Adds the required marker. Set `required` on the control as well. */
  required?: boolean;
};

export function FieldLabel({
  className,
  children,
  required = false,
  ...props
}: FieldLabelProps) {
  const t = useTranslations('common');

  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn(
        'flex items-center gap-1 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2',
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <>
          <span aria-hidden="true" className="text-accent">
            •
          </span>
          <span className="sr-only">{t('required')}</span>
        </>
      ) : null}
    </FieldPrimitive.Label>
  );
}

export function FieldDescription({
  className,
  ...props
}: FieldPrimitive.Description.Props) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn('text-xs text-ink-3', className)}
      {...props}
    />
  );
}

export function FieldControl({
  className,
  ...props
}: FieldPrimitive.Control.Props) {
  return (
    <FieldPrimitive.Control
      data-slot="field-control"
      className={cn(
        'h-[38px] w-full min-w-0 rounded-input border border-line bg-ground-2 px-3 text-sm text-ink',
        'placeholder:text-ink-3',
        'transition-colors duration-150 hover:border-line-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'data-[invalid]:border-tone-stop',
        className,
      )}
      {...props}
    />
  );
}

export function FieldError({
  className,
  ...props
}: FieldPrimitive.Error.Props) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn('text-xs text-tone-stop', className)}
      {...props}
    />
  );
}

/**
 * Groups related fields inside a form panel. Two columns from `sm` up; a field
 * that owns a whole idea (notes, a location picker) passes `span="full"`.
 */
export function FieldGroup({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2',
        className,
      )}
      {...props}
    />
  );
}

export function FieldSpanFull({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="field-span-full"
      className={cn('min-w-0 sm:col-span-2', className)}
      {...props}
    />
  );
}

/**
 * A read-only value rendered in the same rhythm as an editable field, so a
 * detail view and its edit form do not reflow when you switch between them.
 */
export function FieldReadout({
  label,
  value,
  mono = false,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div data-slot="field-readout" className="flex min-w-0 flex-col gap-1">
      <span className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
        {label}
      </span>
      <span className={cn('text-sm text-ink', mono && 'font-mono text-xs')}>
        {value}
      </span>
    </div>
  );
}
