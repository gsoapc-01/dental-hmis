-- SmartDental HMIS - 0014: trusted staff membership provisioning foundation

BEGIN;

CREATE FUNCTION public.provision_clinic_staff_membership(
	p_clinic_id uuid,
	p_user_id uuid,
	p_display_name text,
	p_role public.user_role_enum
)
RETURNS public.clinic_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
	target_clinic_id uuid;
	target_auth_user_id uuid;
	existing_membership_clinic_id uuid;
	created_membership public.clinic_memberships;
BEGIN
	IF p_clinic_id IS NULL OR p_user_id IS NULL THEN
		RAISE EXCEPTION 'Clinic and Auth user IDs are required';
	END IF;

	IF p_role IS NULL OR p_role NOT IN (
		'admin'::public.user_role_enum,
		'doctor'::public.user_role_enum,
		'receptionist'::public.user_role_enum
	) THEN
		RAISE EXCEPTION 'Only admin, doctor, and receptionist roles can be provisioned';
	END IF;

	SELECT clinic.id INTO target_clinic_id
	FROM public.clinics AS clinic
	WHERE clinic.id = p_clinic_id;
	IF target_clinic_id IS NULL THEN
		RAISE EXCEPTION 'Target clinic was not found';
	END IF;

	-- Serialize all provisioning attempts for this Auth identity, including
	-- attempts targeting different clinics, before checking existing memberships.
	SELECT auth_user.id INTO target_auth_user_id
	FROM auth.users AS auth_user
	WHERE auth_user.id = p_user_id
	FOR UPDATE;
	IF target_auth_user_id IS NULL THEN
		RAISE EXCEPTION 'Target Auth user was not found';
	END IF;

	SELECT membership.clinic_id INTO existing_membership_clinic_id
	FROM public.clinic_memberships AS membership
	WHERE membership.user_id = p_user_id
		AND membership.clinic_id = p_clinic_id;
	IF existing_membership_clinic_id IS NOT NULL THEN
		RAISE EXCEPTION 'Target Auth user already has a membership in this clinic';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM public.clinic_memberships AS membership
		WHERE membership.user_id = p_user_id
	) THEN
		RAISE EXCEPTION 'Target Auth user already belongs to another clinic';
	END IF;

	INSERT INTO public.profiles AS existing_profile (id, display_name)
	VALUES (p_user_id, NULLIF(btrim(p_display_name), ''))
	ON CONFLICT (id) DO UPDATE
	SET display_name = EXCLUDED.display_name,
			updated_at = now()
	WHERE NULLIF(btrim(existing_profile.display_name), '') IS NULL
		AND EXCLUDED.display_name IS NOT NULL;

	INSERT INTO public.clinic_memberships (
		user_id,
		clinic_id,
		role,
		is_active
	)
	VALUES (
		p_user_id,
		p_clinic_id,
		p_role,
		true
	)
	RETURNING * INTO created_membership;

	RETURN created_membership;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_clinic_staff_membership(uuid, uuid, text, public.user_role_enum)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_clinic_staff_membership(uuid, uuid, text, public.user_role_enum)
TO service_role;

COMMIT;
