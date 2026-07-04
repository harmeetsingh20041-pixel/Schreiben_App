alter table public.global_questions
add column if not exists source_key text,
add column if not exists sort_order integer,
add column if not exists source_label text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'global_questions_source_key_key'
  ) then
    alter table public.global_questions
    add constraint global_questions_source_key_key unique (source_key);
  end if;
end;
$$;

create index if not exists global_questions_level_active_sort_idx
on public.global_questions (level, is_active, sort_order, created_at desc);

insert into public.global_questions (
  source_key,
  sort_order,
  source_label,
  title,
  prompt,
  level,
  topic,
  task_type,
  expected_word_min,
  expected_word_max,
  estimated_minutes,
  is_active
) values
(
  'a2_block1_aufgabe_01',
  1,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 1 - Sofa kaufen',
  $prompt$Sie suchen ein Sofa und haben in der Zeitung eine Anzeige gelesen. Schreiben Sie an Frau Müller eine E-Mail.
- Warum schreiben Sie?
- Preis?
- Abholen: wo?$prompt$,
  'A2',
  'Kaufen',
  'email',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_02',
  2,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 2 - Geburtstagsparty',
  $prompt$Sie feiern nächste Woche Ihren Geburtstag und machen deshalb eine Party. Laden Sie Ihre Freunde zu Ihrer Geburtstagsparty ein.
- Warum schreiben Sie?
- Wann?
- Mitbringen?$prompt$,
  'A2',
  'Einladung',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_03',
  3,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 3 - Treffen verschieben',
  $prompt$Ihre Freundin Nina will Sie am Samstag treffen. Sie können nicht. Antworten Sie Ihrer Freundin mit einer E-Mail.
- Warum schreiben Sie?
- Treffen: wann?
- Mitbringen?$prompt$,
  'A2',
  'Treffen',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_04',
  4,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 4 - Kühlschrank Hilfe',
  $prompt$Sie bekommen am Dienstag einen Kühlschrank. Aber Sie sind nicht zu Hause. Bitten Sie Frau Meyer um ihre Hilfe.
- Warum schreiben Sie?
- Uhrzeit?
- Schlüssel?$prompt$,
  'A2',
  'Hilfe',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_05',
  5,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 5 - Arbeit als Verkäufer/in',
  $prompt$Sie möchten als Verkäufer/in arbeiten und haben im Internet eine Anzeige gelesen. Schreiben Sie an Frau Riedl eine E-Mail.
- Warum schreiben Sie?
- Arbeitszeit?
- Informationen über sich$prompt$,
  'A2',
  'Beruf',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_06',
  6,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 6 - Essen bestellen',
  $prompt$Sie feiern am nächsten Samstag Ihren Geburtstag und möchten für 30 Personen Essen bestellen. Das Restaurant soll es zu Ihnen nach Hause bringen. Schreiben Sie an das Restaurant eine E-Mail.
- Warum schreiben Sie?
- Welches Essen?
- Preis?$prompt$,
  'A2',
  'Bestellung',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_07',
  7,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 7 - Essen gehen mit Anna',
  $prompt$Sie haben Ihre Freundin Anna seit Langem nicht gesehen und möchten mit ihr essen gehen. Schreiben Sie Ihrer Freundin eine E-Mail.
- Warum schreiben Sie?
- Treffen: wann?
- Essen: wo?$prompt$,
  'A2',
  'Treffen',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_08',
  8,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 8 - Jonas in Hamburg besuchen',
  $prompt$Sie wollen Ihren Freund Jonas in Hamburg besuchen. Schreiben Sie an Jonas.
- Warum schreiben Sie?
- Wann?
- Abholen?$prompt$,
  'A2',
  'Reise',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_09',
  9,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 9 - Deutschkurs München',
  $prompt$Sie möchten in München einen Deutschkurs machen. Schreiben Sie an den Kurs eine E-Mail.
- Warum schreiben Sie?
- Wann?
- Preis?$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_10',
  10,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 10 - Neue Wohnung Party',
  $prompt$Sie haben eine neue Wohnung und möchten eine Party machen. Laden Sie Ihre Freunde ein.
- Warum schreiben Sie?
- Wann?
- Mitbringen?$prompt$,
  'A2',
  'Einladung',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_11',
  11,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 11 - Restaurant Drei Sterne',
  $prompt$Sie haben Geburtstag und möchten am Samstag im Restaurant „Drei Sterne“ eine Party machen. Schreiben Sie an Frau _____ eine E-Mail.
- Warum schreiben Sie?
- Informationen über Party/Fest?
- Welches Essen?/Preise?$prompt$,
  'A2',
  'Feier',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_12',
  12,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 12 - Wohnung suchen',
  $prompt$Sie suchen eine Wohnung und haben im Internet eine Anzeige gelesen. Schreiben Sie eine E-Mail.
- Warum schreiben Sie?
- Informationen über die Wohnung?
- Preis?$prompt$,
  'A2',
  'Wohnen',
  'email',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_13',
  13,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 13 - Flugticket kaufen',
  $prompt$Sie wollen im Internet ein Flugticket kaufen. Schreiben Sie an ein Reisebüro eine E-Mail.
- Warum schreiben Sie?
- Informationen über die Reise
- Preise?$prompt$,
  'A2',
  'Reise',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_14',
  14,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 14 - Hotelzimmer reservieren',
  $prompt$Sie möchten im Internet ein Hotelzimmer reservieren. Schreiben Sie an das Reisebüro eine E-Mail.
- Warum schreiben Sie?
- Informationen über das Zimmer
- Fragen Sie nach den Preisen.$prompt$,
  'A2',
  'Reise',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_15',
  15,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 15 - Jasmin besuchen',
  $prompt$Ihre Freundin Jasmin hat ein Baby bekommen und Sie möchten sie zu Hause besuchen.
- Warum schreiben Sie?
- Wann besuchen?
- Geschenk?$prompt$,
  'A2',
  'Besuch',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_16',
  16,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 16 - Sportverein anmelden',
  $prompt$Sie möchten Sport machen. In Ihrer Stadt gibt es einen Sportverein und Sie möchten sich anmelden. Schreiben Sie an den Verein eine E-Mail.
- Warum schreiben Sie?
- Welcher Sport?
- Wann?$prompt$,
  'A2',
  'Sport',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_17',
  17,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 17 - Umzug Hilfe',
  $prompt$Sie ziehen in die Berliner Straße 117 um. Sie haben kein Auto. Bitten Sie Ihren Freund um Hilfe. Sagen Sie:
- Warum schreiben Sie?
- Wann?
- Auto?$prompt$,
  'A2',
  'Umzug',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_18',
  18,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 18 - Kochkurs Berlin',
  $prompt$Sie möchten einen Kochkurs in Berlin besuchen. Schreiben Sie an den Kurs eine E-Mail.
- Warum schreiben Sie?
- Wann?
- Preis?$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_19',
  19,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 19 - Nicht zum Deutschkurs',
  $prompt$Sie können nächste Woche nicht zum Deutschkurs gehen. Schreiben Sie eine E-Mail an Ihre/n Lehrer/in. Sagen Sie:
- Warum schreiben Sie?
- Wann wieder?
- Hausaufgaben?$prompt$,
  'A2',
  'Entschuldigung',
  'apology',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_20',
  20,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 20 - Lehrerin zur Party einladen',
  $prompt$Schreiben Sie eine E-Mail an Ihre Lehrerin Frau Schmidt vom Kurs. Laden Sie sie zu Ihrer Party ein.
- Warum schreiben Sie?
- Party: wann?
- Mitbringen?$prompt$,
  'A2',
  'Einladung',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_21',
  21,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 21 - Computerkurs Expo',
  $prompt$Sie möchten einen Computerkurs bei der Firma Expo machen. Schreiben Sie an die Firma.
- Warum schreiben Sie?
- Preis?
- Uhrzeit?$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_22',
  22,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 22 - Zimmer in Leipzig',
  $prompt$Sie brauchen für Donnerstagabend ein Zimmer in Leipzig. Schreiben Sie an Frau Riedler. Sagen Sie:
- Warum schreiben Sie?
- Preis?
- Ankunftszeit?$prompt$,
  'A2',
  'Reise',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_23',
  23,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 23 - Schrank kaufen',
  $prompt$Sie suchen einen Schrank und haben in der Zeitung eine Anzeige gelesen. Schreiben Sie an den Verkäufer Mark Müller eine E-Mail.
- Warum schreiben Sie?
- Preis?
- Abholen?$prompt$,
  'A2',
  'Kaufen',
  'email',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_24',
  24,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 24 - Neues Haus Party',
  $prompt$Sie haben ein neues Haus und möchten eine Party machen. Schreiben Sie an einen Freund / an eine Freundin:
- Warum schreiben Sie?
- Wann?
- Ihr Freund / Ihre Freundin soll nichts zum Essen mitbringen.$prompt$,
  'A2',
  'Einladung',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_25',
  25,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 25 - Kurs in Deutschland',
  $prompt$Sie möchten in Deutschland einen Kurs machen. Schreiben Sie an den Kurs eine E-Mail.
- Warum schreiben Sie?
- Wann?
- Prüfung?$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_26',
  26,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 26 - Auto kaufen',
  $prompt$Sie suchen ein Auto und haben im Internet eine Anzeige gelesen. Schreiben Sie eine E-Mail.
- Warum schreiben Sie?
- Informationen über das Auto
- Preis?$prompt$,
  'A2',
  'Kaufen',
  'email',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_27',
  27,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 27 - Hilfe beim Deutschlernen',
  $prompt$Sie haben Probleme beim Deutschlernen. Schreiben Sie an Ihre Freundin Diana eine E-Mail und bitten Sie um Hilfe.
- Warum schreiben Sie?
- Fragen Sie: Wann treffen?
- Sagen Sie: wo?$prompt$,
  'A2',
  'Lernen',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_28',
  28,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 28 - Fahrschule Verkehr',
  $prompt$Sie möchten den Führerschein machen und die Fahrschule „Verkehr“ besuchen. Schreiben Sie eine E-Mail.
- Warum schreiben Sie?
- Wann?
- Preis?$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block1_aufgabe_29',
  29,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 29 - Tenniskurs München',
  $prompt$Sie möchten in München einen Tenniskurs besuchen. Schreiben Sie an den Kurs eine E-Mail.
- Warum schreiben Sie?
- Wann?
- Preis?$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_01',
  30,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 30 - Dresden besuchen',
  $prompt$Sie möchten im August Dresden besuchen. Schreiben Sie an die Touristeninformation:
- Warum schreiben Sie?
- Fragen Sie nach Informationen über Film, Museen usw. (Kulturprogramm).
- Fragen Sie nach Hoteladressen.$prompt$,
  'A2',
  'Reise',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_02',
  31,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 31 - Geburtstag feiern',
  $prompt$Sie möchten Ihren Geburtstag feiern und Ihre Freunde Susanne und Paul einladen. Schreiben Sie an Susanne und Paul:
- Warum schreiben Sie?
- Tag und Uhrzeit?
- Wie können sie kommen?$prompt$,
  'A2',
  'Einladung',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_03',
  32,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 32 - Geburtstagsfeier Kollege',
  $prompt$Ihr neuer Kollege, Herr Jensch, hat Sie am Dienstag um 15 Uhr zu seiner Geburtstagsfeier im Büro eingeladen. Schreiben Sie an Herrn Jensch.
- Warum schreiben Sie?
- Später kommen?
- Helfen?$prompt$,
  'A2',
  'Einladung',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_04',
  33,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 33 - Wohnung besuchen',
  $prompt$Sie haben eine neue Wohnung. Schreiben Sie an Ihre Freunde.
- Beschreiben Sie das Zimmer.
- Fragen Sie, ob sie die Wohnung sehen möchten.
- Zusammen kochen?$prompt$,
  'A2',
  'Wohnen',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_05',
  34,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 34 - Hotel Winterzeit Urlaub',
  $prompt$Sie wollen mit Ihrer Familie im Hotel „Winterzeit“ Urlaub machen. Schreiben Sie an das Hotel „Winterzeit“.
- Urlaubszeit: wann?
- Bitten Sie um Informationen zu Sehenswürdigkeiten.
- Wie viel kostet es?$prompt$,
  'A2',
  'Reise',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_06',
  35,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 35 - Party Hans und Helga',
  $prompt$Sie wollen eine Party machen. Sie möchten Ihre Freunde Hans und Helga einladen. Schreiben Sie an Hans und Helga:
- Warum schreiben Sie?
- Party: wann?
- Mitbringen?$prompt$,
  'A2',
  'Einladung',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_07',
  36,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 36 - Tochter krank',
  $prompt$Ihre Tochter Anna ist krank. Schreiben Sie eine Entschuldigung für die Schule. Annas Lehrerin heißt Frau Kleinert.
- Warum schreiben Sie?
- Wann kann Anna den Unterricht nicht besuchen?
- Fragen Sie nach Annas Hausaufgaben.$prompt$,
  'A2',
  'Entschuldigung',
  'apology',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_08',
  37,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 37 - Ticket Frankfurt Sydney',
  $prompt$Sie suchen ein günstiges Ticket von Frankfurt nach Sydney. Schreiben Sie an Ihr Reisebüro.
- Warum schreiben Sie?
- Sie wollen am 25. Februar 2020 abfliegen und am 14. März zurückkommen.
- Sie möchten nicht mit Qantas Airways fliegen.$prompt$,
  'A2',
  'Reise',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_09',
  38,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 38 - Elterntreffen',
  $prompt$Schreiben Sie Ihrem Freund Siavo eine E-Mail. Schreiben Sie, wann und wo das nächste Elterntreffen ist. Sagen Sie:
- Was? Elterntreffen
- Wann? Freitag, 15. Februar, 19:00 Uhr
- Wo? Café Bremmer, Brachwederstraße 121, 33659 Bielefeld$prompt$,
  'A2',
  'Information',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_10',
  39,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 39 - Wohnung Party Nachbarn',
  $prompt$Sie haben eine neue Wohnung und machen eine Party. Schreiben Sie eine Einladung an Ihre Nachbarn.
- Einladung: warum?
- Party: wann und wo?
- Etwas mitbringen?$prompt$,
  'A2',
  'Einladung',
  'invitation',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_11',
  40,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 40 - Irene Besuch verschieben',
  $prompt$Ihre Freundin Irene will Sie im August besuchen. Schreiben Sie an Irene.
- Sie müssen für Ihre Firma nach Berlin fahren.
- Bitten Sie Ihre Freundin: Sie soll im September kommen.
- Sie haben am 10.9. Geburtstag.$prompt$,
  'A2',
  'Besuch',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_12',
  41,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 41 - Sprachschule Eviva Termin',
  $prompt$Sie möchten in der Sprachschule Eviva einen Deutschkurs machen. Schreiben Sie an den Schulleiter.
- Warum schreiben Sie?
- Anmeldung und Kursgebühr
- Termin$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_13',
  42,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 42 - Nicht kommen Deutschkurs',
  $prompt$Sie können nächste Woche nicht in den Deutschkurs kommen. Schreiben Sie eine Information für Ihre Lehrerin.
- Warum können Sie nicht kommen?
- Frage: Hausaufgaben?
- Wann sind Sie wieder da?$prompt$,
  'A2',
  'Entschuldigung',
  'apology',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_14',
  43,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 43 - Georg in Hamburg besuchen',
  $prompt$Sie wollen Ihren Freund Georg in Hamburg besuchen. Er soll Sie abholen. Schreiben Sie an Georg.
- Warum schreiben Sie?
- Abholen: wo?
- Ankommen: wann?$prompt$,
  'A2',
  'Reise',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_15',
  44,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 44 - Kurs anmelden Herr Berhardt',
  $prompt$Sie waren im letzten Sommer in München in einem Deutschkurs. Ihr Lehrer war Herr Berhardt, eine sehr sympathische Person. Schreiben Sie an Herrn Berhardt.
- Stellen Sie sich vor.
- Gibt es dieses Jahr wieder einen Kurs? Wann?
- Sie möchten sich für den Kurs anmelden.$prompt$,
  'A2',
  'Kurs',
  'formal_letter',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_16',
  45,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 45 - Ausflug mit Sylvia',
  $prompt$Sie möchten am Wochenende einen Ausflug mit dem Auto machen, zusammen mit Ihrer Freundin Sylvia. Schreiben Sie an Sylvia.
- Wohin wollen Sie fahren?
- Was soll Sylvia mitbringen?
- Wo wollen Sie sich treffen?$prompt$,
  'A2',
  'Freizeit',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_17',
  46,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 46 - Reise nach Hamburg',
  $prompt$Sie machen mit Ihrer Familie eine Reise nach Hamburg und wollen dort in einem Hotel bleiben. Ihr Freund holt Sie ab. Schreiben Sie eine Information für Georg.
- Ankunft in Hamburg: wann?
- Welches Hotel?
- Wie viele Personen?$prompt$,
  'A2',
  'Reise',
  'message',
  null,
  null,
  null,
  true
),
(
  'a2_block2_aufgabe_18',
  47,
  'A2_Schreiben_Fragen(1).pdf',
  'A2 Aufgabe 47 - Umziehen Goethestraße',
  $prompt$Sie ziehen in die Goethestraße um. Ihre Freundin Simone hat ein Auto. Sie soll Ihnen helfen. Schreiben Sie an Simone.
- Warum schreiben Sie?
- Umziehen: Tag und Uhrzeit?
- Auto?$prompt$,
  'A2',
  'Umzug',
  'message',
  null,
  null,
  null,
  true
)
on conflict (source_key) do update
set
  sort_order = excluded.sort_order,
  source_label = excluded.source_label,
  title = excluded.title,
  prompt = excluded.prompt,
  level = excluded.level,
  topic = excluded.topic,
  task_type = excluded.task_type,
  expected_word_min = excluded.expected_word_min,
  expected_word_max = excluded.expected_word_max,
  estimated_minutes = excluded.estimated_minutes,
  is_active = excluded.is_active,
  updated_at = now();
