import { IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/** Palette token (e.g. `indigo`) or a hex color (`#rrggbb`). */
export const WALLET_COLOR_PATTERN = /^([a-z]{3,24}|#[0-9a-fA-F]{6})$/;

export class CreateWalletDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(WALLET_COLOR_PATTERN, {
    message: 'color must be a palette token (indigo) or a hex color (#4f46e5)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  color?: string;

  /** Budget lines for the wallet (same shape as the per-key budget column). */
  @IsOptional()
  @IsObject()
  budget?: Record<string, unknown>;
}

export class UpdateWalletDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(WALLET_COLOR_PATTERN, {
    message: 'color must be a palette token (indigo) or a hex color (#4f46e5)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  color?: string;

  @IsOptional()
  @IsObject()
  budget?: Record<string, unknown>;
}

export class AddWalletMemberDto {
  /** The `tenant_providers` id of the provider key joining the wallet. */
  @IsString()
  @IsNotEmpty()
  tenant_provider_id!: string;
}
