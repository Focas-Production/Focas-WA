'use client';

import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OtpTemplateButton, OtpType } from '@/types';
import { AUTH_LIMITS, TEMPLATE_LIMITS } from '@/lib/whatsapp/template-validators';

/** Form-side shape of an authentication template's options. */
export interface AuthFormState {
  otp_type: OtpType;
  button_text: string;
  autofill_text: string;
  package_name: string;
  signature_hash: string;
  security: boolean;
  expiry_enabled: boolean;
  /** Kept as text so the field can be cleared while typing. */
  expiry_minutes: string;
}

export const emptyAuthForm: AuthFormState = {
  otp_type: 'COPY_CODE',
  button_text: 'Copy code',
  autofill_text: 'Autofill',
  package_name: '',
  signature_hash: '',
  security: true,
  expiry_enabled: true,
  expiry_minutes: '10',
};

export function authFormToButton(f: AuthFormState): OtpTemplateButton {
  const minutes = Number(f.expiry_minutes);
  return {
    type: 'OTP',
    otp_type: f.otp_type,
    text: f.button_text.trim(),
    ...(f.otp_type === 'ONE_TAP' && {
      autofill_text: f.autofill_text.trim(),
      supported_apps: [
        { package_name: f.package_name.trim(), signature_hash: f.signature_hash.trim() },
      ],
    }),
    add_security_recommendation: f.security,
    // NaN / 0 are passed through when enabled so validation can flag them.
    ...(f.expiry_enabled && { code_expiration_minutes: minutes }),
  };
}

export function buttonToAuthForm(b: OtpTemplateButton | null): AuthFormState {
  if (!b) return emptyAuthForm;
  const app = b.supported_apps?.[0];
  return {
    otp_type: b.otp_type,
    button_text: b.text || emptyAuthForm.button_text,
    autofill_text: b.autofill_text || emptyAuthForm.autofill_text,
    package_name: app?.package_name ?? '',
    signature_hash: app?.signature_hash ?? '',
    security: !!b.add_security_recommendation,
    expiry_enabled: !!b.code_expiration_minutes,
    expiry_minutes: String(b.code_expiration_minutes ?? emptyAuthForm.expiry_minutes),
  };
}

const fieldCls =
  'bg-muted border-border text-foreground placeholder:text-muted-foreground';

/**
 * Builder for AUTHENTICATION templates. Meta fixes the wording, so the
 * only choices are code delivery, button labels, the security note and
 * the expiry — everything else is generated.
 */
export function TemplateAuthFields({
  value,
  onChange,
}: {
  value: AuthFormState;
  onChange: (patch: Partial<AuthFormState>) => void;
}) {
  const t = useTranslations('Settings.templates');
  const oneTap = value.otp_type === 'ONE_TAP';

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>{t('authIntro')}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-muted-foreground">{t('authDelivery')}</Label>
        <Select
          value={value.otp_type}
          onValueChange={(val) => {
            if (val) onChange({ otp_type: val as OtpType });
          }}
        >
          <SelectTrigger className={`w-full ${fieldCls}`}>
            <SelectValue>
              {(v: string) => (v === 'ONE_TAP' ? t('authOneTap') : t('authCopyCode'))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="COPY_CODE" className="text-popover-foreground focus:bg-muted focus:text-popover-foreground">
              {t('authCopyCode')}
            </SelectItem>
            <SelectItem value="ONE_TAP" className="text-popover-foreground focus:bg-muted focus:text-popover-foreground">
              {t('authOneTap')}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {oneTap ? t('authOneTapHint') : t('authCopyCodeHint')}
        </p>
      </div>

      <div className={`grid gap-4 ${oneTap ? 'sm:grid-cols-2' : ''}`}>
        <div className="space-y-2">
          <Label className="text-muted-foreground">{t('authButtonText')}</Label>
          <Input
            value={value.button_text}
            maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
            onChange={(e) => onChange({ button_text: e.target.value })}
            className={fieldCls}
          />
        </div>
        {oneTap && (
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('authAutofillText')}</Label>
            <Input
              value={value.autofill_text}
              maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
              onChange={(e) => onChange({ autofill_text: e.target.value })}
              className={fieldCls}
            />
          </div>
        )}
      </div>

      {oneTap && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('authPackageName')}</Label>
            <Input
              placeholder="com.example.app"
              value={value.package_name}
              onChange={(e) => onChange({ package_name: e.target.value })}
              className={fieldCls}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('authSignatureHash')}</Label>
            <Input
              placeholder="K8a/AINcGX7"
              value={value.signature_hash}
              maxLength={11}
              onChange={(e) => onChange({ signature_hash: e.target.value })}
              className={`${fieldCls} font-mono`}
            />
          </div>
        </div>
      )}

      <div className="space-y-3 rounded-md border border-border p-3">
        <label className="flex items-center justify-between gap-3">
          <span className="space-y-0.5">
            <span className="block text-sm text-foreground">{t('authSecurity')}</span>
            <span className="block text-[11px] text-muted-foreground">{t('authSecurityHint')}</span>
          </span>
          <Switch
            checked={value.security}
            onCheckedChange={(checked) => onChange({ security: checked })}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <label className="space-y-0.5" htmlFor="auth-expiry-minutes">
            <span className="block text-sm text-foreground">{t('authExpiry')}</span>
            <span className="block text-[11px] text-muted-foreground">
              {t('authExpiryHint', {
                min: AUTH_LIMITS.minExpiryMinutes,
                max: AUTH_LIMITS.maxExpiryMinutes,
              })}
            </span>
          </label>
          <div className="flex items-center gap-2">
            {value.expiry_enabled && (
              <Input
                id="auth-expiry-minutes"
                type="number"
                inputMode="numeric"
                min={AUTH_LIMITS.minExpiryMinutes}
                max={AUTH_LIMITS.maxExpiryMinutes}
                value={value.expiry_minutes}
                onChange={(e) => onChange({ expiry_minutes: e.target.value })}
                className={`${fieldCls} h-8 w-20 text-xs`}
                aria-label={t('authExpiry')}
              />
            )}
            <Switch
              checked={value.expiry_enabled}
              onCheckedChange={(checked) => onChange({ expiry_enabled: checked })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
