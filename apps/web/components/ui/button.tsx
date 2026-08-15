'use client';

import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Vendored from shadcn/ui and re-skinned onto Sancocho's tokens. The headless
 * behaviour (disabled semantics that survive `render`, composite-widget focus
 * handling) is Base UI's; every visual decision below is ours.
 *
 * Sizing note: widths are content-driven and nothing truncates, because the
 * Spanish label is the long one ("Cancelar el servicio" against "Cancel"). Height
 * is fixed, width never is.
 */
const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap',
    'rounded-pill border font-semibold',
    'transition-[background-color,color] duration-150 ease-out',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:pointer-events-none disabled:opacity-45',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  ),
  {
    variants: {
      variant: {
        /** The single accent-filled control on a view. Never two. */
        primary: 'border-transparent bg-accent text-accent-ink hover:bg-accent-hi',
        /** The workhorse. Reads as a control, not as an invitation. */
        secondary: 'border-line bg-ground-2 text-ink hover:bg-ground-3',
        /** Toolbars and table rows, where a border per action would be noise. */
        ghost: 'border-transparent text-ink-2 hover:bg-ground-2 hover:text-ink',
        /**
         * Destructive actions stay outlined until hover: they should be findable
         * and never inviting. Confirmation still happens in a dialog.
         */
        danger: 'border-tone-stop/45 bg-transparent text-tone-stop hover:bg-tone-stop/12 hover:border-tone-stop',
        /** Inline navigation inside running text. */
        link: 'h-auto border-transparent px-0 text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent',
      },
      size: {
        sm: 'h-[30px] px-3 text-xs',
        md: 'h-9 px-4 text-sm',
        lg: 'h-9 px-4 text-sm',
        icon: 'size-9 px-0',
      },
      /** Segmented controls and toolbars: pressed state without a second variant. */
      selected: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      {
        variant: 'secondary',
        selected: true,
        className: 'border-line bg-ground-2 text-ink before:size-1.5 before:rounded-full before:bg-accent',
      },
      {
        variant: 'ghost',
        selected: true,
        className: 'bg-ground-2 text-ink before:size-1.5 before:rounded-full before:bg-accent hover:bg-ground-2',
      },
    ],
    defaultVariants: { variant: 'secondary', size: 'md', selected: false },
  },
);

export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, selected, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, selected }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
